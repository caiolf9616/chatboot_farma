const { normalizarTexto, buscarPorNome, extrairDosagem, medicamentoBateDosagem,
  formatarResposta, ehConfirmacaoAfirmativa, ehSaudacao,
  ehAgendamento, ehFimDeConversa, ehMensagemFinalDaEquipe,
  ehConsultaDisponibilidade, ehDuvidaForaDoEscopo } = require('./medicamentos');

const MENSAGEM_NOVO_CONTATO =
  'Agora pra saber informações sobre medicamentos ou agendamentos, o WhatsApp que deverá entrar em contato é (85) 98682-9000 ' +
  'e pedir para falar com a "Farmácia do Hospital de Messejana".\n' +
  'Pode acessar também clicando no link: https://api.whatsapp.com/send/?phone=5585986829000&text=Quero+falar+com+Hospital+de+Messejana&type=phone_number&app_absent=0\n';
const BOAS_VINDAS = 'Olá.\n' + MENSAGEM_NOVO_CONTATO +
  'A partir de 05/10 esse número será *ENCERRADO*, não tendo mais atendimentos.';
const MENSAGEM_ENCAMINHAMENTO = 'Entendi que você quer agendar. ' +
  'Já vou te encaminhar para o atendimento, aguarde só um instante 🙂';
const MENSAGEM_DESPEDIDA = 'Agradecemos por usar nosso serviço.\nDesejamos muita saúde para você. 🙂\n' +
  MENSAGEM_NOVO_CONTATO +
  'A partir de 05/10 esse número será ENCERRADO, não tendo mais atendimentos.';
const MENSAGEM_ATENDIMENTO = 'Vou te encaminhar para o atendimento para que a equipe possa te ajudar. Aguarde só um instante 🙂';
const MENSAGEM_PEDIR_MEDICAMENTO = 'Não consegui identificar sua consulta. Envie o nome do medicamento e, se souber, a dosagem. 🙂';
const MENSAGEM_FORA_ESCOPO = 'Posso consultar a disponibilidade de medicamentos. Para esse assunto, fale com a equipe da farmácia. ' +
  'Se quiser consultar o estoque, envie o nome do medicamento.';

function mensagemEmFalta(nome) {
  return `No momento o *${nome}* está em falta e não temos previsão de quando a medicação vai chegar. ` +
    'Podemos agendar ou reagendar para quando ela chegar, mas não temos como avisar automaticamente — ' +
    'você vai precisar ficar verificando com a gente periodicamente até que volte a ficar disponível.';
}

function nomeCompletoValido(texto) {
  const palavras = texto.trim().split(/\s+/);
  return texto.length <= 150 && palavras.length >= 2 &&
    palavras.every(palavra => /^[\p{L}]+(?:['’-][\p{L}]+)*$/u.test(palavra)) &&
    !/\b(nao|quero|sei|informar|obrigado|obrigada|agendar|primeira|vez)\b/.test(normalizarTexto(texto));
}

function nascimentoValido(texto, agora) {
  const partes = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
  if (!partes) return false;
  const [, dia, mes, ano] = partes.map(Number);
  const data = new Date(ano, mes - 1, dia);
  return ano >= 1900 && data.getFullYear() === ano && data.getMonth() === mes - 1 &&
    data.getDate() === dia && data.getTime() <= agora;
}

function criarAtendimento({ catalogo, agora = Date.now, ttlMs = 300000,
  esperar = () => Promise.resolve(), logger = console }) {
  const sessoes = new Map();
  const filas = new Map();
  const execucoes = new Map();
  function limparExpirados() {
    for (const [contato, sessao] of sessoes) {
      if (agora() - sessao.timestamp >= ttlMs) sessoes.delete(contato);
    }
  }
  function salvar(contato, estado) {
    if (execucoes.get(contato)?.cancelada) return;
    sessoes.set(contato, { ...estado, timestamp: agora() });
  }
  async function responder(msg, texto) {
    if (execucoes.get(msg.from)?.cancelada) return;
    await esperar();
    if (execucoes.get(msg.from)?.cancelada) return;
    await msg.reply(texto);
  }
  async function encaminharFoto(msg) {
    salvar(msg.from, { tipo: 'manual' });
    await responder(msg, MENSAGEM_ATENDIMENTO);
  }
  async function pedirEsclarecimento(msg, sessao) {
    if (sessao?.tipo === 'confirmacao') {
      await responder(msg, `Você quis dizer *${sessao.candidato.nome_medicamento}*?\n` +
        'Responda sim ou não, ou envie o nome de outro medicamento.');
      return;
    }
    if (sessao?.tipo === 'escolha') {
      await pedirEscolha(msg, sessao.candidatos);
      return;
    }
    await responder(msg, MENSAGEM_PEDIR_MEDICAMENTO);
  }
  function observarMensagemEnviada(msg) {
    if (!msg?.fromMe || msg.isStatus || typeof msg.to !== 'string' ||
      msg.to.endsWith('@g.us') || msg.to.endsWith('@broadcast') ||
      typeof msg.body !== 'string' || !ehMensagemFinalDaEquipe(msg.body)) return;
    // A mensagem enviada pelo atendente encerra também uma resposta ainda em preparo.
    const ativa = execucoes.get(msg.to);
    if (ativa) ativa.cancelada = true;
    sessoes.set(msg.to, { tipo: 'encerrado', timestamp: agora() });
  }
  async function mostrarDisponibilidade(msg, medicamento, { confirmar = false, unidadeDiferente = false } = {}) {
    // Reconsulta o cache atual: uma confirmação não reutiliza estoque de cinco minutos atrás.
    const atual = (await catalogo.buscarTodos()).find(med => med.nome_medicamento === medicamento.nome_medicamento);
    if (execucoes.get(msg.from)?.cancelada) return;
    if (!atual || typeof atual.em_falta !== 'boolean') {
      sessoes.delete(msg.from);
      await responder(msg, 'Não consegui confirmar a disponibilidade desse medicamento no cadastro. ' +
        'Você pode tentar novamente mais tarde ou enviar o nome de outro medicamento.');
      return;
    }
    if (confirmar) {
      salvar(msg.from, { tipo: 'confirmacao', candidato: atual });
      await responder(msg, `Você quis dizer *${atual.nome_medicamento}*?\n` +
        (unidadeDiferente ? 'A unidade informada é diferente da cadastrada.\n' : '') +
        'Responda sim ou não.');
      return;
    }
    salvar(msg.from, { tipo: 'consulta', medicamento: atual });
    await responder(msg, formatarResposta(atual));
  }
  async function pedirEscolha(msg, candidatos, introducao = 'Encontrei mais de uma opção:') {
    salvar(msg.from, { tipo: 'escolha', candidatos });
    const lista = candidatos.slice(0, 10).map(med => `• ${med.nome_medicamento}`).join('\n');
    await responder(msg, `${introducao}\n\n${lista}\n\n` +
      'Informe o nome e a dosagem completa, incluindo a unidade (mg, mcg etc.).');
  }
  async function iniciarAgendamento(msg, sessao) {
    const todos = await catalogo.buscarTodos();
    if (execucoes.get(msg.from)?.cancelada) return;
    let citados = buscarPorNome(todos, msg.body).filter(med => med._pontuacaoBusca === 1);
    const dosagem = extrairDosagem(msg.body);
    if (dosagem.length) citados = citados.filter(med => medicamentoBateDosagem(med.nome_medicamento, dosagem));
    const medicamento = citados.length === 1 ? citados[0]
      : citados.length === 0 && !dosagem.length && sessao?.tipo === 'consulta'
        ? todos.find(med => med.nome_medicamento === sessao.medicamento.nome_medicamento) : null;
    // Falta de estoque tem prioridade, inclusive para Tafamidis.
    if (medicamento?.em_falta === true) {
      salvar(msg.from, { tipo: 'manual' });
      await responder(msg, mensagemEmFalta(medicamento.nome_medicamento));
      return;
    }
    if (medicamento?.em_falta === false &&
      /\btafamidis\b/.test(normalizarTexto(`${medicamento.nome_medicamento} ${medicamento.principio_ativo || ''}`))) {
      salvar(msg.from, { tipo: 'tafamidis_primeira_vez', medicamento });
      await responder(msg, `Essa é a primeira vez que você vai retirar *${medicamento.nome_medicamento}* ` +
        'aqui no hospital? Responda sim ou não.');
      return;
    }
    salvar(msg.from, { tipo: 'manual' });
    await responder(msg, MENSAGEM_ENCAMINHAMENTO);
  }
  async function continuarTafamidis(msg, sessao) {
    // O estoque pode mudar entre a consulta e a coleta dos dados.
    const atual = (await catalogo.buscarTodos()).find(med => med.nome_medicamento === sessao.medicamento.nome_medicamento);
    if (execucoes.get(msg.from)?.cancelada) return;
    if (atual?.em_falta !== false) {
      salvar(msg.from, { tipo: 'manual' });
      await responder(msg, atual?.em_falta === true ? mensagemEmFalta(atual.nome_medicamento)
        : 'Não consegui confirmar a disponibilidade desse medicamento. ' + MENSAGEM_ENCAMINHAMENTO);
      return;
    }
    const texto = msg.body.trim();
    if (sessao.tipo === 'tafamidis_primeira_vez') {
      if (ehConfirmacaoAfirmativa(texto) || /^(e a |e minha |minha )?primeira vez$/.test(normalizarTexto(texto))) {
        salvar(msg.from, { tipo: 'tafamidis_nome', medicamento: atual });
        await responder(msg, 'Para a primeira retirada, precisamos do seu nome completo e da sua data de nascimento. ' +
          'Primeiro, envie seu nome completo.');
      } else if (/^(nao|nao e a primeira vez|ja retirei|ja peguei|nao ja retirei|nao ja peguei)$/.test(normalizarTexto(texto))) {
        salvar(msg.from, { tipo: 'manual' });
        await responder(msg, MENSAGEM_ENCAMINHAMENTO);
      } else {
        await responder(msg, 'É a sua primeira retirada desse medicamento aqui no hospital? Responda sim ou não.');
      }
      return;
    }
    if (sessao.tipo === 'tafamidis_nome') {
      if (!nomeCompletoValido(texto)) {
        await responder(msg, 'Por favor, envie seu nome completo, com nome e sobrenome, ou digite "cancelar".');
        return;
      }
      salvar(msg.from, { tipo: 'tafamidis_nascimento', medicamento: atual });
      await responder(msg, 'Agora envie sua data de nascimento no formato DD/MM/AAAA.');
      return;
    }
    if (!nascimentoValido(texto, agora())) {
      await responder(msg, 'Não consegui validar a data de nascimento. Envie uma data válida no formato DD/MM/AAAA.');
      return;
    }
    salvar(msg.from, { tipo: 'manual' });
    await responder(msg, 'Recebi seu nome completo e sua data de nascimento nesta conversa. ' +
      'O agendamento da primeira retirada de ' + atual.nome_medicamento +
      ' ainda precisa ser confirmado pela equipe da farmácia. ' +
      'Para retomar a consulta automática, envie "consultar".');
  }
  async function processar(msg) {
    limparExpirados();
    const sessao = sessoes.get(msg.from);
    if (msg.type === 'image') {
      // A foto segue para a equipe sem interpretar a imagem ou sua legenda.
      if (sessao?.tipo !== 'manual') await encaminharFoto(msg);
      return;
    }
    const texto = msg.body.trim();
    const normalizado = normalizarTexto(texto);
    if (/^(cancelar|sair|encerrar)$/.test(normalizado)) {
      sessoes.delete(msg.from);
      await responder(msg, 'Consulta encerrada. Para começar novamente, envie o nome do medicamento.');
      return;
    }
    if (sessao?.tipo === 'confirmacao' && ehConfirmacaoAfirmativa(texto)) {
      await mostrarDisponibilidade(msg, sessao.candidato);
      return;
    }
    if (ehFimDeConversa(texto)) {
      // A despedida não reativa o bot durante o atendimento humano.
      if (sessao?.tipo !== 'manual') salvar(msg.from, { tipo: 'encerrado' });
      if (/^(ok|okay|okey)$/.test(normalizado)) return;
      await responder(msg, MENSAGEM_DESPEDIDA);
      return;
    }
    if (sessao?.tipo === 'manual') {
      if (normalizado === 'consultar') {
        sessoes.delete(msg.from);
        await responder(msg, BOAS_VINDAS);
      }
      return;
    }
    if (ehSaudacao(texto) || normalizado === 'consultar') {
      sessoes.delete(msg.from);
      await responder(msg, BOAS_VINDAS);
      return;
    }
    if (sessao?.tipo === 'encerrado' && /^(sim|nao|comprovante recebido)$/.test(normalizado)) return;
    if (ehDuvidaForaDoEscopo(texto)) {
      sessoes.delete(msg.from);
      await responder(msg, MENSAGEM_FORA_ESCOPO);
      return;
    }
    if (ehAgendamento(texto)) {
      await iniciarAgendamento(msg, sessao);
      return;
    }
    if (sessao?.tipo.startsWith('tafamidis_')) {
      await continuarTafamidis(msg, sessao);
      return;
    }
    if (sessao?.tipo === 'confirmacao' && /^(nao|nao e esse|nao e essa|nao quero|negativo)$/.test(normalizado)) {
      sessoes.delete(msg.from);
      await responder(msg, 'Tudo bem! Envie novamente o nome do medicamento e, se souber, a dosagem. 🙂');
      return;
    }
    if (texto.length > 1000) {
      await pedirEsclarecimento(msg, sessao);
      return;
    }
    const todos = await catalogo.buscarTodos();
    if (execucoes.get(msg.from)?.cancelada) return;
    let candidatos = buscarPorNome(todos, texto);
    const dosagem = extrairDosagem(texto);
    let unidadeDiferente = false;
    const soDosagem = /^\s*[\d\s.,/+%]*(?:(?:mcg|ug|mg|g|ml|ui|l)\s*[\d\s.,/+%]*)*\s*$/i.test(texto);
    if (!soDosagem && !ehConsultaDisponibilidade(texto, candidatos)) {
      await pedirEsclarecimento(msg, sessao);
      return;
    }
    if (!candidatos.length && dosagem.length && soDosagem) {
      const nomesPendentes = sessao?.tipo === 'escolha'
        ? new Set(sessao.candidatos.map(med => med.nome_medicamento)) : null;
      candidatos = todos.filter(med => !nomesPendentes || nomesPendentes.has(med.nome_medicamento))
        .filter(med => medicamentoBateDosagem(med.nome_medicamento, dosagem));
      if (candidatos.length === 1) {
        salvar(msg.from, { tipo: 'confirmacao', candidato: candidatos[0] });
        await responder(msg, `Você quis dizer *${candidatos[0].nome_medicamento}*? Responda sim ou não.`);
        return;
      }
    } else if (dosagem.length && candidatos.length) {
      let filtrados = candidatos.filter(med => medicamentoBateDosagem(med.nome_medicamento, dosagem));
      if (!filtrados.length) {
        // Os mesmos valores com outra unidade são apenas uma sugestão a confirmar.
        // Nunca converte unidades nem troca o valor ou os componentes da dosagem.
        const somenteValores = dosagem.map(parte => ({ ...parte, unidade: null }));
        filtrados = candidatos.filter(med => medicamentoBateDosagem(med.nome_medicamento, somenteValores));
        unidadeDiferente = filtrados.length > 0;
      }
      if (!filtrados.length) {
        await pedirEscolha(msg, candidatos, 'Não encontrei a dosagem informada. Confira as opções cadastradas:');
        return;
      }
      candidatos = filtrados;
    }
    if (!candidatos.length) {
      await pedirEsclarecimento(msg, sessao);
      return;
    }
    if (candidatos.length > 1) {
      await pedirEscolha(msg, candidatos);
      return;
    }
    const candidato = candidatos[0];
    if (candidato._pontuacaoBusca < 1 || unidadeDiferente) {
      await mostrarDisponibilidade(msg, candidato, { confirmar: true, unidadeDiferente });
      return;
    }
    await mostrarDisponibilidade(msg, candidato);
  }

  function receber(msg) {
    if (!msg || msg.fromMe || msg.isStatus || typeof msg.from !== 'string' ||
      msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) {
      return Promise.resolve();
    }
    const foto = msg.type === 'image';
    if (!foto && (msg.hasMedia || (msg.type && msg.type !== 'chat') ||
      typeof msg.body !== 'string' || !msg.body.trim())) {
      return Promise.resolve();
    }
    const anterior = filas.get(msg.from) || Promise.resolve();
    const execucao = { cancelada: false };
    const tarefa = anterior.then(() => {
      execucoes.set(msg.from, execucao);
      return processar(msg);
    }).catch(async erro => {
      if (execucao.cancelada) return;
      // Não registrar texto, telefone ou CPF em logs.
      logger.error('Falha no atendimento:', erro.code || erro.name || 'Erro');
      sessoes.delete(msg.from);
      try {
        await msg.reply('Não consegui consultar agora devido a um problema técnico. ' +
          'Tente novamente em instantes ou solicite atendimento humano pelo canal habitual da farmácia.');
      } catch (falhaEnvio) {
        logger.error('Falha ao enviar aviso:', falhaEnvio.code || falhaEnvio.name || 'Erro');
      }
    });
    filas.set(msg.from, tarefa);
    return tarefa.finally(() => {
      if (execucoes.get(msg.from) === execucao) execucoes.delete(msg.from);
      if (filas.get(msg.from) === tarefa) filas.delete(msg.from);
    });
  }
  return { receber, limparExpirados, observarMensagemEnviada };
}

module.exports = { criarAtendimento };
