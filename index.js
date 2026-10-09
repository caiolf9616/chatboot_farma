const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const client = new Client({
  authStrategy: new LocalAuth(),
  // O encerramento é controlado abaixo; evita dois fechamentos no Ctrl+C.
  puppeteer: {
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
  }
});

let etapaConexao = 'abrindo o navegador do WhatsApp';
let avisoConexao;
let paginaMonitorada;
let conexaoPronta = false;
let aguardandoQr = false;
let tentativaConexao = 0;
let geracaoConexao = 0;
let encerrando = false;
let fechamentoNavegador = null;

client.on('qr', (qr) => {
  aguardandoQr = true;
  clearTimeout(avisoConexao);
  etapaConexao = 'aguardando leitura do QR code';
  console.log('Escaneie o QR code abaixo com o WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percentual, mensagem) => {
  etapaConexao = `carregando WhatsApp: ${percentual}% - ${mensagem}`;
});

client.on('authenticated', () => {
  if (aguardandoQr && !encerrando) programarLimiteConexao();
  aguardandoQr = false;
  etapaConexao = 'sessão autenticada; aguardando o WhatsApp ficar pronto';
  // Erros na preparação do WhatsApp podem ocorrer dentro da página,
  // fora da Promise retornada por initialize().
  if (client.pupPage && paginaMonitorada !== client.pupPage) {
    paginaMonitorada = client.pupPage;
    paginaMonitorada.on('pageerror', (erro) => {
      console.error('Erro interno na página do WhatsApp:', erro.message || erro);
    });
    paginaMonitorada.on('error', (erro) => {
      console.error('Falha no navegador do WhatsApp:', erro.message || erro);
    });
  }
});

client.on('auth_failure', (mensagem) => {
  clearTimeout(avisoConexao);
  console.error('Falha na autenticação do WhatsApp:', mensagem);
});

client.on('disconnected', (motivo) => {
  clearTimeout(avisoConexao);
  console.error('WhatsApp desconectado:', motivo);
});

client.on('ready', () => {
  if (encerrando) return;
  conexaoPronta = true;
  clearTimeout(avisoConexao);
  console.log('✅ Bot conectado e pronto!');
});

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const API_URL = 'http://10.10.29.55:3103/api/consulta/medicamentos';

let cacheMedicamentos = null;
let cacheTimestamp = 0;

const CACHE_DURACAO_MS = 60 * 1000;

// Tempo que o bot mantém uma pergunta de dosagem pendente
const TEMPO_EXPIRACAO_MS = 5 * 60 * 1000;

// ============================================================
// CACHE DOS MEDICAMENTOS
// ============================================================

async function buscarTodosMedicamentos() {
  const agora = Date.now();

  if (
    cacheMedicamentos &&
    (agora - cacheTimestamp) < CACHE_DURACAO_MS
  ) {
    return cacheMedicamentos;
  }

  const resp = await axios.get(API_URL, { timeout: 15_000 });

  cacheMedicamentos = resp.data;
  cacheTimestamp = agora;

  return cacheMedicamentos;
}

// ============================================================
// NORMALIZAÇÃO DE TEXTO
// ============================================================

function normalizarTexto(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[?!.,;:()[\]{}]/g, '')
    // colapsa 3+ letras repetidas em 1 -- "obrigadooo" -> "obrigado",
    // "aleniaaa" -> "alenia" -- sem afetar dobras normais do
    // português (ex: "carro", "assar"), que têm só 2 repetições
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// SAUDAÇÃO
//
// Se a mensagem for SÓ uma saudação (bom dia, boa tarde, etc),
// responde com a mensagem de boas-vindas.
//
// Não depende do horário real -- só reconhece o que o próprio
// paciente escreveu. Se vier combinado com uma pergunta
// (ex: "Bom dia, tem entresto?"), NÃO dispara aqui -- cai
// direto na busca do medicamento, que já ignora "bom dia"
// como stopword.
// ============================================================

function ehSaudacao(texto) {
  const msg = normalizarTexto(texto);

  if (!msg) {
    return false;
  }

  // palavras (não frases inteiras) que sozinhas ou combinadas
  // formam uma saudação -- assim "oi bom dia", "bom dia",
  // "boa tarde", "oi" etc. todos funcionam, mas se aparecer
  // qualquer palavra fora dessa lista (ex: "entresto"), já não
  // conta mais como saudação pura e cai pra busca do remédio
  const palavrasSaudacao = new Set([
    'oi', 'oii', 'oie', 'ola', 'fala', 'eae', 'eai', 'e', 'ai',
    'opa', 'salve',
    'bom', 'boa', 'dia', 'tarde', 'noite'
  ]);

  const palavras = msg.split(/\s+/);

  return palavras.every((p) => palavrasSaudacao.has(p));
}

const MENSAGEM_BOAS_VINDAS =
  'Olá! Bem-vindo à Farmácia do Hospital de Messejana.\n' +
  'Qual medicamento você gostaria de consultar? Informe o nome e, se souber, a dosagem.';

// ============================================================
// PERGUNTA GENÉRICA SOBRE MEDICAÇÃO
//
// Quando a pessoa manda só "medicações", "sobre medicamentos",
// "remédio" etc -- sem citar nome nenhum -- não faz sentido
// ficar em silêncio nem tentar buscar. Melhor pedir pra
// especificar qual remédio.
// ============================================================

function ehPerguntaGenericaSobreMedicamento(texto) {
  const msg = normalizarTexto(texto);
  return /\bmedic\w*\b|\bremedi\w*\b/.test(msg);
}

// ============================================================
// AGRADECIMENTOS
// ============================================================

function ehAgradecimento(texto) {
  const msg = normalizarTexto(texto);

  const agradecimentos = [
    'obrigado',
    'obrigada',
    'obg',
    'obgd',
    'obrigado mesmo',
    'obrigada mesmo',
    'muito obrigado',
    'muito obrigada',
    'valeu',
    'valeu mesmo',
    'agradecido',
    'agradecida',
    'agradecimento',
    'agradecimentos',
    'brigado',
    'brigada'
  ];

  return agradecimentos.some((palavra) => {
    return (
      msg === palavra ||
      msg.startsWith(palavra + ' ') ||
      msg.endsWith(' ' + palavra) ||
      msg.includes(' ' + palavra + ' ')
    );
  });
}

// ============================================================
// SEPARA LETRAS E NÚMEROS
// ============================================================

function separarLetrasNumeros(texto) {
  return texto
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');
}

// ============================================================
// STOPWORDS
// ============================================================

const STOPWORDS = [
  'tem',
  'vcs',
  'voces',
  'voce',
  'vc',
  'tera',
  'possui',
  'disponivel',
  'estoque',
  'o',
  'a',
  'de',
  'do',
  'da',
  'para',
  'pra',
  'ai',
  'esse',
  'essa',
  'isso',
  'ja',
  'chegou',
  'medicacao',
  'medicamento',
  'medicamentos',
  'gostaria',
  'saber',
  'se',
  'bom',
  'boa',
  'dia',
  'tarde',
  'noite',
  'por',
  'favor',
  'ola',
  'oi',
  'com',
  'sem',
  'uma',
  'um',
  'ou',
  'e',
  'temos',
  'teria',
  'teriam',
  'me',
  'manda',
  'mandar',
  'preciso',
  'precisa',
  'queria',
  'quero',
  'qual',
  'quais'
];

// ============================================================
// LEVENSHTEIN
// ============================================================

function levenshtein(a, b) {
  if (a === b) return 0;

  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matriz = Array.from(
    { length: b.length + 1 },
    (_, i) => i
  );

  for (let j = 1; j <= a.length; j++) {
    let anterior = j;

    for (let i = 1; i <= b.length; i++) {
      const valor = (
        a[j - 1] === b[i - 1]
          ? matriz[i - 1]
          : Math.min(
              matriz[i - 1],
              matriz[i],
              anterior
            ) + 1
      );

      matriz[i - 1] = anterior;
      anterior = valor;
    }

    matriz[b.length] = anterior;
  }

  return matriz[b.length];
}

// ============================================================
// SIMILARIDADE
// ============================================================

function calcularSimilaridade(a, b) {
  a = normalizarTexto(a);
  b = normalizarTexto(b);

  if (!a || !b) return 0;

  if (a === b) return 1;

  // Prefixo é uma correspondência muito forte
  if (a.startsWith(b) || b.startsWith(a)) {
    const menor = Math.min(a.length, b.length);
    const maior = Math.max(a.length, b.length);

    return 0.90 + (menor / maior) * 0.10;
  }

  const distancia = levenshtein(a, b);

  return 1 - (
    distancia / Math.max(a.length, b.length)
  );
}

// ============================================================
// BUSCA FUZZY
//
// Essa parte é responsável por erros como:
//
// Forxiga     -> Formiga
// Atorvastatina -> Atorvanstatina
// Losartana   -> Losartana
// Budesonida  -> Budesonidda
// ============================================================

function bateParcial(palavraBusca, palavraAlvo) {
  palavraBusca = normalizarTexto(palavraBusca);
  palavraAlvo = normalizarTexto(palavraAlvo);

  if (!palavraBusca || !palavraAlvo) {
    return false;
  }

  if (palavraBusca === palavraAlvo) {
    return true;
  }

  // Palavras muito pequenas precisam ser exatas
  if (palavraBusca.length < 4 || palavraAlvo.length < 4) {
    return false;
  }

  // Prefixos
  if (
    palavraAlvo.startsWith(palavraBusca) ||
    palavraBusca.startsWith(palavraAlvo)
  ) {
    return true;
  }

  const distancia = levenshtein(
    palavraBusca,
    palavraAlvo
  );

  const tamanhoMaior = Math.max(
    palavraBusca.length,
    palavraAlvo.length
  );

  const similaridade =
    1 - (distancia / tamanhoMaior);

  // Tolerância dinâmica.
  //
  // Palavras maiores podem ter alguns erros de digitação.
  //
  // 6-7 letras: ~70%
  // 8+ letras: ~75%
  //
  // Isso permite casos como:
  // formiga -> forxiga
  // atorvanstatina -> atorvastatina

  if (tamanhoMaior >= 10) {
    return similaridade >= 0.72;
  }

  if (tamanhoMaior >= 8) {
    return similaridade >= 0.72;
  }

  if (tamanhoMaior >= 6) {
    return similaridade >= 0.68;
  }

  return similaridade >= 0.75;
}

// ============================================================
// PONTUAÇÃO DE UMA PALAVRA
// ============================================================

function pontuarPalavra(palavraBusca, palavraAlvo) {
  palavraBusca = normalizarTexto(palavraBusca);
  palavraAlvo = normalizarTexto(palavraAlvo);

  if (!palavraBusca || !palavraAlvo) {
    return 0;
  }

  if (palavraBusca === palavraAlvo) {
    return 1;
  }

  const similaridade = calcularSimilaridade(
    palavraBusca,
    palavraAlvo
  );

  if (!bateParcial(palavraBusca, palavraAlvo)) {
    return 0;
  }

  return similaridade;
}

// ============================================================
// PEGA AS PALAVRAS DO MEDICAMENTO
// ============================================================

function palavrasMedicamento(med) {
  const nome = normalizarTexto(
    med.nome_medicamento || ''
  );

  const principio = normalizarTexto(
    med.principio_ativo || ''
  );

  return [
    ...nome.split(/\s+/),
    ...principio.split(/\s+/)
  ].filter(Boolean);
}

// ============================================================
// COMPARA MEDICAMENTO COM AS PALAVRAS DA BUSCA
// ============================================================

function pontuarMedicamento(med, palavrasBusca) {
  const palavrasAlvo = palavrasMedicamento(med);

  if (!palavrasAlvo.length || !palavrasBusca.length) {
    return 0;
  }

  let melhorPontuacao = 0;

  for (const palavraBusca of palavrasBusca) {
    for (const palavraAlvo of palavrasAlvo) {
      const pontuacao = pontuarPalavra(
        palavraBusca,
        palavraAlvo
      );

      if (pontuacao > melhorPontuacao) {
        melhorPontuacao = pontuacao;
      }
    }
  }

  return melhorPontuacao;
}

// ============================================================
// VERIFICA SE MEDICAMENTO BATE COM AS PALAVRAS
// ============================================================

function medicamentoBatePalavras(med, palavrasBusca) {
  return pontuarMedicamento(
    med,
    palavrasBusca
  ) > 0;
}

// ============================================================
// BUSCA POR NOME DO MEDICAMENTO
//
// Primeiro tenta correspondência normal.
// Depois usa busca fuzzy.
// ============================================================

async function buscarPorNome(mensagem) {
  const todos = await buscarTodosMedicamentos();

  const msgNorm = separarLetrasNumeros(
    normalizarTexto(mensagem)
  );

  const palavras = msgNorm
    .split(/\s+/)
    .filter(
      (p) =>
        p.length >= 4 &&
        !STOPWORDS.includes(p) &&
        !/\d/.test(p)
    );

  if (palavras.length === 0) {
    return [];
  }

  const resultados = [];

  for (const med of todos) {
    const pontuacao = pontuarMedicamento(
      med,
      palavras
    );

    if (pontuacao > 0) {
      resultados.push({
        med,
        pontuacao
      });
    }
  }

  // Melhor correspondência primeiro
  resultados.sort(
    (a, b) => b.pontuacao - a.pontuacao
  );

  // Remove medicamentos repetidos
  const encontrados = new Set();
  const finais = [];

  for (const resultado of resultados) {
    const nome = resultado.med.nome_medicamento;

    if (!encontrados.has(nome)) {
      encontrados.add(nome);

      finais.push({
        ...resultado.med,
        _pontuacaoBusca: resultado.pontuacao
      });
    }
  }

  return finais;
}

// ============================================================
// EXTRAI DOSAGEM
// ============================================================

function extrairDosagem(texto) {
  const matches =
    texto.match(
      /\d+(?:[.,]\d+)?(?:\/\d+(?:[.,]\d+)?)?/g
    ) || [];

  const normalizados = matches.map(
    (m) => m.replace(',', '.')
  );

  // Combina números adjacentes
  //
  // Exemplo:
  // "12 400"
  //
  // também poderá procurar:
  // "12/400"

  const combinados = [];

  for (
    let i = 0;
    i < normalizados.length - 1;
    i++
  ) {
    combinados.push(
      `${normalizados[i]}/${normalizados[i + 1]}`
    );
  }

  return [
    ...new Set([
      ...normalizados,
      ...combinados
    ])
  ];
}

// ============================================================
// COMPARA DOSAGEM
// ============================================================

// verifica se um número dado pelo paciente bate com o token do
// remédio -- ou inteiro (ex: "100" == "100"), ou como PARTE de
// um combo (ex: "400" bate dentro de "12/400", já que o paciente
// muitas vezes só menciona metade da dosagem combinada)
function numeroBateToken(numeroMsg, tokenNome) {
  if (tokenNome === numeroMsg) {
    return true;
  }
  if (tokenNome.includes('/')) {
    return tokenNome.split('/').includes(numeroMsg);
  }
  return false;
}

function medicamentoBateDosagem(
  nomeMedicamento,
  numerosMsg
) {
  const numerosNome =
    extrairDosagem(nomeMedicamento);

  return numerosMsg.some(
    (n) => numerosNome.some((tokenNome) => numeroBateToken(n, tokenNome))
  );
}

// ============================================================
// FILTRA CANDIDATOS POR TEXTO
// ============================================================

function filtrarCandidatosPorTexto(
  candidatos,
  texto
) {
  const palavras =
    separarLetrasNumeros(
      normalizarTexto(texto)
    )
      .split(/\s+/)
      .filter(
        (p) =>
          p.length >= 3 &&
          !/\d/.test(p)
      );

  if (palavras.length === 0) {
    return [];
  }

  const resultados = [];

  for (const med of candidatos) {
    const pontuacao = pontuarMedicamento(
      med,
      palavras
    );

    if (pontuacao > 0) {
      resultados.push({
        med,
        pontuacao
      });
    }
  }

  resultados.sort(
    (a, b) => b.pontuacao - a.pontuacao
  );

  return resultados.map(
    (resultado) => resultado.med
  );
}

// ============================================================
// FORMATA RESPOSTA
// ============================================================

function formatarResposta(med) {
  const emoji = med.em_falta
    ? '❌'
    : '✅';

  return (
    `${emoji} ${med.nome_medicamento} — ` +
    `${med.em_falta ? 'Em falta' : 'Disponível'}`
  );
}

// ============================================================
// CLASSIFICAÇÃO DE INTENÇÃO
// ============================================================

function ehPerguntaSobrePrevisao(texto) {
  const msg = normalizarTexto(texto);
  return /\bprevisao\b/.test(msg) ||
    /\bquando\b.*\b(chega|chegar|chegara|volta|voltar|tera|ter|repoe|repor)\b/.test(msg) ||
    /\b(data|prazo)\b.*\b(chegada|reposicao|abastecimento)\b/.test(msg);
}

function normalizarTextoAgendamento(texto) {
  const termos = ['consulta', 'consultas', 'marcacao', 'marcacoes',
    'remarcacao', 'remarcacoes', 'agendar', 'agendamento'];
  const correcoes = { consutla: 'consulta', consutlas: 'consultas' };
  return normalizarTexto(texto).replace(/[a-z]+/g, (palavra) => {
    // "Consultar" costuma ser consulta de estoque, não marcação médica.
    if (palavra === 'consultar' || palavra.length < 6) return palavra;
    if (correcoes[palavra]) return correcoes[palavra];
    if (termos.includes(palavra)) return palavra;
    return termos.find((termo) => levenshtein(palavra, termo) <= 1) || palavra;
  });
}

function classificarIntencao(texto) {
  const msg = normalizarTextoAgendamento(texto);

  const palavrasAgendamento = [
    'agendar',
    'reagendar',
    'reagendamento',
    'agendamento',
    'marcar',
    'consulta',
    'consultas',
    'marcacao',
    'marcacoes',
    'remarcacao',
    'remarcacoes',
    'exame',
    'exames',
    'consulta medica',
    'remarcar',
    'quero agendar',
    'preciso agendar',
    'marcar consulta',
    'horario disponivel',
    'data da consulta',
    'quero marcar'
  ];

  const palavrasDisponibilidade = [
    'tem',
    'disponibilidade',
    'estoque',
    'voces tem',
    'vcs tem',
    'possui',
    'chegou',
    'ja chegou',
    'ta tendo',
    'tem entrada'
  ];

  if (
    palavrasAgendamento.some(
      (p) => (` ${msg} `).includes(` ${p} `)
    )
  ) {
    return 'AGENDAMENTO';
  }

  if (
    palavrasDisponibilidade.some(
      (p) => msg.includes(p)
    )
  ) {
    return 'DISPONIBILIDADE';
  }

  return 'AMBIGUO';
}

const PERGUNTA_TIPO_AGENDAMENTO =
  'Você quer agendar para:\n\n' +
  '1 - Medicação\n' +
  '2 - Exame\n' +
  '3 - Consulta com médico\n\n' +
  'Pode responder com o número ou escrever a opção.';

const PERGUNTA_MEDICACAO_AGENDAMENTO =
  'Qual medicação você precisa receber? Informe o nome e, se souber, a dosagem.';

const MENSAGEM_DADOS_AGENDAMENTO =
  'Para poder realizar o agendamento para receber o medicamento, preciso de alguns dados do paciente:\n\n' +
  '- Nome completo\n' +
  '- Data de nascimento\n' +
  '- Nome da mãe';

const MENSAGEM_ASSISTENTE_HM = `Confira o novo número do Assistente Virtual 💬📲

O (85) 98682-9000 é o canal oficial de WhatsApp do Governo do Ceará. Para acessar as informações do Hospital de Messejana, basta enviar a mensagem:

👉 “Quero falar com o Hospital de Messejana”

A partir desse comando, você será direcionado para o atendimento virtual do HM e poderá consultar informações sobre:

- Marcação de exames
- Marcação de consultas
- Funcionamento da Farmácia Ambulatorial
- Horários de atendimento
- Regras para visitas e troca de acompanhantes
- Acesso à Ouvidoria
- E muito mais!

📲 Salve o número: (85) 98682-9000

Compartilhe essa novidade!`;

function identificarTipoAgendamento(texto, aceitaNumero = false) {
  const msg = normalizarTexto(texto);
  if (aceitaNumero && /^[123]$/.test(msg)) {
    return msg === '1' ? 'MEDICACAO' : 'EXAME_OU_MEDICO';
  }
  const medicacao = /\b(medicacao|medicacoes|medicamento|medicamentos|remedio|remedios|farmacia)\b/.test(msg);
  const exameOuMedico = /\b(exame|exames|medico|medica|medicos|medicas|doutor|doutora|dr|dra)\b/.test(msg);
  if (medicacao === exameOuMedico) return null;
  return medicacao ? 'MEDICACAO' : 'EXAME_OU_MEDICO';
}

// ============================================================
// ESTADO DA CONVERSA
// ============================================================

const aguardandoDosagem = new Map();
const aguardandoTipoAgendamento = new Map();
const agendamentoMedicacao = new Map();

// guarda o último medicamento que cada contato consultou com
// sucesso (resultado único, sem ambiguidade) -- usado pra saber
// se um pedido de agendamento ou previsão logo em seguida é
// sobre esse remédio específico
const ultimoMedicamentoConsultado = new Map();

// controla as etapas do fluxo especial de agendamento do
// Tafamidis: 'primeira_vez' (aguardando resposta se é a
// primeira vez) -> 'dados' (aguardando nome/CPF/telefone)
const tafamidisPendente = new Map();

// nome (ou parte dele) que identifica o medicamento que tem
// fluxo de agendamento especial -- ajuste aqui se precisar
// incluir outro remédio no futuro
const MEDICAMENTOS_FLUXO_ESPECIAL = ['tafamidis'];

function ehMedicamentoComFluxoEspecial(nomeMedicamento) {
  const nomeNorm = normalizarTexto(nomeMedicamento || '');
  return MEDICAMENTOS_FLUXO_ESPECIAL.some((m) => nomeNorm.includes(m));
}

// guarda um candidato aguardando confirmação (ex: paciente mandou
// só "12 400mcg" sem nome, achamos 1 remédio com essa dosagem e
// perguntamos "você quer dizer Alenia 12/400?")
const confirmacaoPendente = new Map();

function registrarUltimoMedicamento(contato, medicamento) {
  ultimoMedicamentoConsultado.set(contato, {
    nome: medicamento.nome_medicamento,
    emFalta: medicamento.em_falta,
    timestamp: Date.now()
  });
}

// busca em TODA a lista de medicamentos por dosagem, sem
// depender do nome -- usado quando o paciente manda só a
// dosagem (ex: "12 400mcg") sem citar o remédio
async function buscarPorDosagem(dosagens) {
  const todos = await buscarTodosMedicamentos();
  return todos.filter((med) =>
    medicamentoBateDosagem(med.nome_medicamento, dosagens)
  );
}

// reconhece uma resposta afirmativa curta (usada pra confirmar
// um candidato sugerido, tipo "sim", "é", "esse mesmo", "isso")
function ehConfirmacaoAfirmativa(texto) {
  const msg = normalizarTexto(texto);

  if (!msg) return false;

  const afirmativas = [
    'sim', 'e', 'isso', 'isso mesmo', 'esse mesmo', 'essa mesma',
    'exato', 'exatamente', 'correto', 'certo', 'positivo',
    'isso ai', 'e isso mesmo', 'e isso', 'e esse', 'e essa'
  ];

  return afirmativas.some((p) =>
    msg === p ||
    msg.startsWith(p + ' ') ||
    msg.endsWith(' ' + p) ||
    msg.includes(' ' + p + ' ')
  );
}

// checagem mínima pra saber se a mensagem parece conter dados
// reais (nome/CPF/telefone), e não uma interjeição qualquer
// tipo "ok", "certo", "blz" -- não é validação rigorosa, só
// evita confirmar recebimento de algo que claramente não é dado
function pareceDadosPessoais(texto) {
  const msg = normalizarTexto(texto);

  if (!msg) return false;

  const temNumeros = /\d{3,}/.test(msg); // CPF/telefone tem vários dígitos
  const temVariasPalavras = msg.split(/\s+/).filter(Boolean).length >= 2;
  const tamanhoRazoavel = msg.length >= 8;

  return temNumeros || (temVariasPalavras && tamanhoRazoavel);
}

// ============================================================
// DELAY HUMANO
// ============================================================

async function delayHumano() {
  await new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        2000 + Math.random() * 1500
      )
  );
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================

let sequenciaMensagem = 0;

client.on('message', async (msg) => {
  if (encerrando || msg.fromMe || !/@(c\.us|lid)$/.test(msg.from || '')) return;
  if (!['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker',
    'location', 'vcard', 'multi_vcard', 'list_response', 'buttons_response',
    'interactive', 'poll_creation'].includes(msg.type)) return;
  const contato = msg.from;
  const numeroMensagem = ++sequenciaMensagem;
  const prefixoLog = `[Mensagem ${numeroMensagem}]`;

  // Avisa somente em caso de demora ou erro, sem registrar dados do paciente.
  async function responder(texto) {
    const avisoEnvio = setTimeout(() => {
      console.warn(`${prefixoLog} O WhatsApp ainda não concluiu o envio após 20 segundos.`);
    }, 20_000);
    avisoEnvio.unref();
    try {
      return await msg.reply(texto);
    } finally {
      clearTimeout(avisoEnvio);
    }
  }

  async function continuarAgendamentoMedicacao(medicamento) {
    registrarUltimoMedicamento(contato, medicamento);
    if (medicamento.em_falta === true) {
      agendamentoMedicacao.delete(contato);
      await responder(formatarResposta(medicamento));
      return;
    }
    if (medicamento.em_falta !== false) {
      await responder('Não consegui confirmar a disponibilidade dessa medicação. O atendimento precisa verificar antes de continuar o agendamento.');
      return;
    }
    agendamentoMedicacao.set(contato, { etapa: 'dados', timestamp: Date.now() });
    await responder(MENSAGEM_DADOS_AGENDAMENTO);
  }

  try {

    // Áudio desativado por enquanto. Quando a mensagem tem
    // foto/mídia, o texto que a pessoa escreveu vem na legenda
    // (msg.caption), não em msg.body -- por isso consideramos
    // os dois, senão uma foto com "12/400" escrito embaixo
    // chegaria aqui como texto vazio.
    const textoMensagem = (msg.body || msg.caption || '').trim();

    let pedidoMedicacao = agendamentoMedicacao.get(contato);
    if (pedidoMedicacao && Date.now() - pedidoMedicacao.timestamp >= TEMPO_EXPIRACAO_MS) {
      agendamentoMedicacao.delete(contato);
      pedidoMedicacao = null;
    }

    let intencao = classificarIntencao(textoMensagem);
    const inicioEscolha = aguardandoTipoAgendamento.get(contato);
    const escolhendoAgendamento = inicioEscolha !== undefined &&
      (Date.now() - inicioEscolha) < TEMPO_EXPIRACAO_MS;
    if (inicioEscolha !== undefined && !escolhendoAgendamento) {
      aguardandoTipoAgendamento.delete(contato);
    }

    if ((escolhendoAgendamento || pedidoMedicacao) && /^(cancelar|sair|encerrar)$/.test(normalizarTexto(textoMensagem))) {
      aguardandoTipoAgendamento.delete(contato);
      agendamentoMedicacao.delete(contato);
      await responder('Certo, cancelei a escolha do agendamento.');
      return;
    }

    if (intencao === 'AGENDAMENTO' || escolhendoAgendamento) {
      const tipo = identificarTipoAgendamento(textoMensagem, escolhendoAgendamento);
      // Um novo pedido de agendamento substitui perguntas anteriores.
      aguardandoDosagem.delete(contato);
      confirmacaoPendente.delete(contato);
      tafamidisPendente.delete(contato);
      agendamentoMedicacao.delete(contato);
      const consultaAnterior = ultimoMedicamentoConsultado.get(contato);
      if (
        tipo !== 'EXAME_OU_MEDICO' &&
        consultaAnterior?.emFalta === true &&
        Date.now() - consultaAnterior.timestamp < TEMPO_EXPIRACAO_MS
      ) {
        const atuais = (await buscarTodosMedicamentos()).filter(
          med => med.nome_medicamento === consultaAnterior.nome
        );
        if (atuais.length === 1) {
          registrarUltimoMedicamento(contato, atuais[0]);
          if (atuais[0].em_falta === true) {
            aguardandoTipoAgendamento.delete(contato);
            await delayHumano();
            await responder(
              `No momento o ${atuais[0].nome_medicamento} está em falta e não temos previsão de quando a medicação vai chegar. ` +
              'Podemos agendar ou reagendar para quando ela chegar, mas não temos como avisar automaticamente — ' +
              'você vai precisar ficar verificando com a gente periodicamente até que volte a ficar disponível.'
            );
            return;
          }
        }
      }
      if (!tipo) {
        aguardandoTipoAgendamento.set(contato, Date.now());
        await delayHumano();
        await responder(PERGUNTA_TIPO_AGENDAMENTO);
        return;
      }
      aguardandoTipoAgendamento.delete(contato);
      if (tipo === 'EXAME_OU_MEDICO') {
        await delayHumano();
        await responder(MENSAGEM_ASSISTENTE_HM);
        return;
      }
      agendamentoMedicacao.set(contato, { etapa: 'medicamento', timestamp: Date.now() });
      const ultimaMedicacao = ultimoMedicamentoConsultado.get(contato);
      if (ultimaMedicacao && Date.now() - ultimaMedicacao.timestamp < TEMPO_EXPIRACAO_MS) {
        const medicamentos = await buscarTodosMedicamentos();
        const encontrados = medicamentos.filter(med => med.nome_medicamento === ultimaMedicacao.nome);
        if (encontrados.length === 1) {
          await delayHumano();
          await continuarAgendamentoMedicacao(encontrados[0]);
          return;
        }
      }
      await delayHumano();
      await responder(PERGUNTA_MEDICACAO_AGENDAMENTO);
      return;
    }

    if (pedidoMedicacao) {
      if (pedidoMedicacao.etapa === 'atendimento') return;
      if (pedidoMedicacao.etapa === 'dados') {
        await responder('Recebi sua mensagem. Aguarde o atendimento conferir os dados e confirmar o agendamento.');
        agendamentoMedicacao.set(contato, { etapa: 'atendimento', timestamp: Date.now() });
        return;
      }

      let candidatos;
      if (pedidoMedicacao.etapa === 'confirmacao' && ehConfirmacaoAfirmativa(textoMensagem)) {
        // Consulta novamente para não usar uma disponibilidade antiga na confirmação.
        candidatos = (await buscarTodosMedicamentos()).filter(
          med => med.nome_medicamento === pedidoMedicacao.nome
        );
      } else {
        candidatos = await buscarPorNome(textoMensagem);
        const dosagens = extrairDosagem(textoMensagem);
        const apenasDosagem = /^[\d\s.,/\-]+(?:mg|mcg|g|ml)?$/i.test(textoMensagem);
        if (!candidatos.length && apenasDosagem && pedidoMedicacao.candidatos) {
          const nomes = new Set(pedidoMedicacao.candidatos);
          candidatos = (await buscarTodosMedicamentos()).filter(med => nomes.has(med.nome_medicamento));
        }
        if (dosagens.length) {
          candidatos = candidatos.filter(med => medicamentoBateDosagem(med.nome_medicamento, dosagens));
        }
      }

      await delayHumano();
      if (!candidatos.length) {
        await responder('Não consegui identificar essa medicação e dosagem. Pode informar o nome completo e a dosagem que você precisa?');
        return;
      }
      if (candidatos.length > 1) {
        agendamentoMedicacao.set(contato, {
          etapa: 'medicamento', timestamp: Date.now(),
          candidatos: candidatos.map(med => med.nome_medicamento)
        });
        await responder('Encontrei mais de uma opção:\n\n' +
          candidatos.slice(0, 10).map(med => `• ${med.nome_medicamento}`).join('\n') +
          '\n\nQual medicação e dosagem você precisa?');
        return;
      }
      const medicamento = candidatos[0];
      if (medicamento._pontuacaoBusca < 1) {
        agendamentoMedicacao.set(contato, {
          etapa: 'confirmacao', nome: medicamento.nome_medicamento, timestamp: Date.now()
        });
        await responder(`Você quis dizer *${medicamento.nome_medicamento}*?`);
        return;
      }
      await continuarAgendamentoMedicacao(medicamento);
      return;
    }

    // Uma pergunta de previsão retoma o último medicamento em falta
    // informado nesta conversa, dentro do prazo de contexto existente.
    const ultimaConsulta = ultimoMedicamentoConsultado.get(contato);
    if (
      ultimaConsulta?.emFalta === true &&
      (Date.now() - ultimaConsulta.timestamp) < TEMPO_EXPIRACAO_MS &&
      ehPerguntaSobrePrevisao(textoMensagem)
    ) {
      await delayHumano();
      await responder('Infelizmente não temos previsão 😔');
      return;
    }

    // ========================================================
    // 0) SAUDAÇÃO
    //
    // Se a mensagem for SÓ "bom dia", "boa tarde", etc,
    // responde com a mensagem de boas-vindas.
    //
    // Se vier junto com uma pergunta (ex: "bom dia, tem
    // entresto?"), não entra aqui -- cai direto na busca
    // do medicamento.
    // ========================================================

    if (ehSaudacao(textoMensagem)) {

      await delayHumano();

      await responder(MENSAGEM_BOAS_VINDAS);

      return;
    }

    // ========================================================
    // 0b) AGRADECIMENTO
    //
    // Se a pessoa disser:
    //
    // obrigado
    // obg
    // obrigada
    // muito obrigado
    // valeu
    //
    // encerra a conversa.
    // ========================================================

    if (intencao !== 'AGENDAMENTO' && ehAgradecimento(textoMensagem)) {

      // Remove eventual pergunta de dosagem pendente
      aguardandoDosagem.delete(contato);

      await delayHumano();

      await responder(
        'Agradecemos por usar nosso serviço.\n' +
        'Desejamos muita saúde para você. 🙂'
      );

      return;
    }

    // ========================================================
    // 1) FLUXO ESPECIAL DE AGENDAMENTO (ex: Tafamidis)
    //
    // Se esse contato está no meio do fluxo de confirmação
    // pra agendar um medicamento de controle especial.
    // ========================================================

    const tafamidisEtapa = tafamidisPendente.get(contato);

    if (
      tafamidisEtapa &&
      (Date.now() - tafamidisEtapa.timestamp) < TEMPO_EXPIRACAO_MS
    ) {

      if (tafamidisEtapa.etapa === 'primeira_vez') {

        await delayHumano();

        await responder(
          'Certo! Agora, por favor, envie os seguintes dados ' +
          'para que a equipe da farmácia confirme com você:\n\n' +
          '• Nome completo\n' +
          '• CPF\n' +
          '• Telefone para contato'
        );

        tafamidisPendente.set(contato, {
          etapa: 'dados',
          medicamento: tafamidisEtapa.medicamento,
          timestamp: Date.now()
        });

        return;
      }

      if (tafamidisEtapa.etapa === 'dados') {

        if (!pareceDadosPessoais(textoMensagem)) {

          await delayHumano();

          await responder(
            'Não consegui identificar seus dados na mensagem. ' +
            'Por favor, envie: nome completo, CPF e telefone ' +
            'para contato.'
          );

          return;
        }

        await delayHumano();

        await responder(
          'Obrigado! Seus dados foram registrados. ' +
          'A equipe da farmácia vai entrar em contato para ' +
          'confirmar o agendamento do ' + tafamidisEtapa.medicamento + '.'
        );

        tafamidisPendente.delete(contato);

        return;
      }
    }

    // ========================================================
    // 1b) CONFIRMAÇÃO DE CANDIDATO POR DOSAGEM PURA
    //
    // Se sugerimos um remédio (ex: "Você quer dizer Alenia
    // 12/400?") e o paciente confirma, responde a disponibilidade.
    // ========================================================

    const confirmacao = confirmacaoPendente.get(contato);

    if (
      confirmacao &&
      (Date.now() - confirmacao.timestamp) < TEMPO_EXPIRACAO_MS
    ) {

      confirmacaoPendente.delete(contato);

      if (ehConfirmacaoAfirmativa(textoMensagem)) {

        await delayHumano();

        await responder(
          formatarResposta(confirmacao.candidato)
        );

        registrarUltimoMedicamento(
          contato,
          confirmacao.candidato
        );

        return;
      }

      // não confirmou -> trata a mensagem como nova,
      // segue o fluxo normal abaixo
    }

    // ========================================================
    // 2) VERIFICA SE EXISTE PERGUNTA DE DOSAGEM PENDENTE
    // ========================================================

    const pendente =
      aguardandoDosagem.get(contato);

    if (
      pendente &&
      (Date.now() - pendente.timestamp) <
        TEMPO_EXPIRACAO_MS
    ) {

      const numeros =
        extrairDosagem(textoMensagem);

      // ------------------------------------------------------
      // Tenta primeiro pela dosagem
      // ------------------------------------------------------

      let filtrados =
        numeros.length > 0
          ? pendente.candidatos.filter(
              (m) =>
                medicamentoBateDosagem(
                  m.nome_medicamento,
                  numeros
                )
            )
          : [];

      // ------------------------------------------------------
      // Se não achou por número, usa busca fuzzy por texto
      // ------------------------------------------------------

      if (filtrados.length === 0) {
        filtrados =
          filtrarCandidatosPorTexto(
            pendente.candidatos,
            textoMensagem
          );
      }

      if (filtrados.length === 1) {

        aguardandoDosagem.delete(contato);

        await delayHumano();

        await responder(
          `Você quis dizer *${filtrados[0].nome_medicamento}*?`
        );

        confirmacaoPendente.set(contato, {
          candidato: filtrados[0],
          timestamp: Date.now()
        });

        return;
      }

      if (filtrados.length > 1) {

        await delayHumano();

        await responder(
          filtrados
            .map(formatarResposta)
            .join('\n')
        );

        aguardandoDosagem.delete(
          contato
        );

        return;
      }

      // Não conseguiu identificar a dosagem na resposta.
      // Em vez de desistir calado, pergunta de novo mantendo
      // os candidatos -- mas só até um limite de tentativas,
      // pra não ficar em loop infinito se a pessoa quiser
      // falar de outra coisa.
      const tentativas = (pendente.tentativas || 0) + 1;

      if (tentativas <= 2) {

        const nomesCandidatos = pendente.candidatos
          .slice(0, 10)
          .map((m) => `• ${m.nome_medicamento}`)
          .join('\n');

        await delayHumano();

        await responder(
          'Não consegui identificar a dosagem. ' +
          'Pode escrever qual dessas opções você precisa?\n\n' +
          nomesCandidatos
        );

        aguardandoDosagem.set(contato, {
          candidatos: pendente.candidatos,
          tentativas: tentativas,
          timestamp: Date.now()
        });

        return;
      }

      // Já perguntou duas vezes sem sucesso -- desiste e
      // trata como mensagem nova

      aguardandoDosagem.delete(
        contato
      );
    }

    // ========================================================
    // 2) FLUXO NORMAL
    // ========================================================

    // ========================================================
    // AGENDAMENTO
    // ========================================================

    if (
      intencao === 'AGENDAMENTO'
    ) {

      const ultimoMed = ultimoMedicamentoConsultado.get(contato);

      const consultaRecente =
        ultimoMed &&
        (Date.now() - ultimoMed.timestamp) < TEMPO_EXPIRACAO_MS;

      // REGRA 1 (tem prioridade sobre tudo): se o remédio está
      // em falta, nem entra em fluxo especial -- vale pra
      // qualquer medicamento, Tafamidis incluído.
      if (consultaRecente && ultimoMed.emFalta === true) {

        await delayHumano();

        await responder(
          'No momento o *' + ultimoMed.nome + '* está em falta ' +
          'e não temos previsão de quando a medicação vai chegar. ' +
          'Podemos agendar ou reagendar para quando ela chegar, ' +
          'mas não temos como avisar automaticamente — você vai ' +
          'precisar ficar verificando com a gente periodicamente ' +
          'até que volte a ficar disponível.'
        );

        return;
      }

      // REGRA 2: medicamento de fluxo especial (ex: Tafamidis)
      // E disponível -- aí sim pergunta se é a primeira vez.
      if (consultaRecente && ehMedicamentoComFluxoEspecial(ultimoMed.nome)) {

        await delayHumano();

        await responder(
          'Antes de encaminhar o agendamento do ' + ultimoMed.nome + ', ' +
          'me diga: essa é a primeira vez que você busca esse ' +
          'medicamento aqui no hospital?'
        );

        tafamidisPendente.set(contato, {
          etapa: 'primeira_vez',
          medicamento: ultimoMed.nome,
          timestamp: Date.now()
        });

        return;
      }

      await delayHumano();

      await responder(
        'Entendi que você quer agendar. ' +
        'Já vou te encaminhar para o atendimento, ' +
        'aguarde só um instante 🙂'
      );

      return;
    }

    // ========================================================
    // 3) BUSCA DO MEDICAMENTO
    //
    // Aqui entra a busca fuzzy.
    // ========================================================

    const resultados =
        await buscarPorNome(
        textoMensagem
      );

    // ========================================================
    // NENHUM MEDICAMENTO ENCONTRADO
    // ========================================================

    if (
      resultados.length === 0
    ) {

      // Mensagem genérica sobre medicação (ex: só "medicações",
      // "sobre remédio"), sem citar nome nenhum -> pergunta qual,
      // em vez de ficar em silêncio.
      if (ehPerguntaGenericaSobreMedicamento(textoMensagem)) {
        await delayHumano();
        await responder(
          'Quais medicações você gostaria de consultar? ' +
          'Pode me dizer o nome.'
        );
        return;
      }

      // Mensagem de texto ambígua -> fica em silêncio
      // para não inventar resposta.

      return;
    }

    // ========================================================
    // EXTRAI DOSAGEM DA MENSAGEM
    // ========================================================

    const numerosNaMensagem =
      extrairDosagem(
        textoMensagem
      );

    await delayHumano();

    // ========================================================
    // SE JÁ TEM DOSAGEM
    // ========================================================

    if (
      numerosNaMensagem.length > 0
    ) {

      const filtrados =
        resultados.filter(
          (m) =>
            medicamentoBateDosagem(
              m.nome_medicamento,
              numerosNaMensagem
            )
        );

      if (
        filtrados.length > 0
      ) {

        await responder(
          filtrados
            .map(formatarResposta)
            .join('\n')
        );

        if (filtrados.length === 1) {
          registrarUltimoMedicamento(
            contato,
            filtrados[0]
          );
        }

        return;
      }

      // Não bateu a dosagem específica.
      // Continua para o fluxo de ambiguidade.
    }

    // ========================================================
    // SOMENTE 1 RESULTADO
    // ========================================================

    if (
      resultados.length === 1
    ) {

      await responder(
        formatarResposta(
          resultados[0]
        )
      );

      registrarUltimoMedicamento(
        contato,
        resultados[0]
      );

      return;
    }

    // ========================================================
    // VÁRIOS RESULTADOS
    // ========================================================

    const nomes =
      resultados
        .slice(0, 10)
        .map(
          (m) =>
            `• ${m.nome_medicamento}`
        )
        .join('\n');

    await responder(
      'Encontrei mais de uma opção:\n\n' +
      `${nomes}\n\n` +
      'Qual a dosagem (mg) você precisa?'
    );

    // Guarda os candidatos para a próxima mensagem
    aguardandoDosagem.set(
      contato,
      {
        candidatos: resultados,
        timestamp: Date.now()
      }
    );

  } catch (erro) {

    console.error(
      `${prefixoLog} Erro ao processar ou responder:`,
      erro.message
    );

    try {
      await responder(
        'Tive um problema técnico pra consultar agora. ' +
        'Vou verificar manualmente.'
      );
    } catch (erroEnvio) {
      console.error(`${prefixoLog} Também não foi possível enviar o aviso de erro:`, erroEnvio.message);
    }
  }
});

// ============================================================
// INICIALIZA O BOT
// ============================================================

async function fecharNavegador() {
  // Compartilha o fechamento caso Ctrl+C chegue durante a recuperação.
  if (!fechamentoNavegador) {
    fechamentoNavegador = client.destroy().finally(() => {
      fechamentoNavegador = null;
    });
  }
  await fechamentoNavegador;
}

async function encerrarBot() {
  if (encerrando) return;
  encerrando = true;
  geracaoConexao++;
  clearTimeout(avisoConexao);
  console.log('Encerrando o bot e fechando seu navegador...');
  try {
    await fecharNavegador();
    process.exit(0);
  } catch (erro) {
    console.error('Erro ao encerrar o navegador do bot:', erro.message);
    process.exit(1);
  }
}
process.on('SIGINT', encerrarBot);
process.on('SIGTERM', encerrarBot);
process.on('SIGHUP', encerrarBot);

async function falharConexao(erro) {
  if (encerrando) return;
  encerrando = true;
  geracaoConexao++;
  clearTimeout(avisoConexao);
  console.error('Erro ao iniciar o bot:', erro?.stack || erro?.message || erro);
  process.exitCode = 1;
  try {
    await fecharNavegador();
  } catch (erroEncerramento) {
    console.error('Erro ao fechar o navegador do bot:', erroEncerramento.message);
  }
}

function programarLimiteConexao() {
  clearTimeout(avisoConexao);
  avisoConexao = setTimeout(async () => {
    if (encerrando || conexaoPronta || aguardandoQr) return;
    if (tentativaConexao >= 2) {
      await falharConexao(new Error(
        `O WhatsApp não ficou pronto após duas tentativas. Última etapa: ${etapaConexao}.`
      ));
      return;
    }
    console.warn('A inicialização demorou mais de 60 segundos. Reiniciando o navegador do bot uma vez...');
    // Descarta rejeições da tentativa antiga causadas pelo fechamento.
    geracaoConexao++;
    try {
      await fecharNavegador();
      if (!encerrando) iniciarBot();
    } catch (erro) {
      await falharConexao(erro);
    }
  }, 60_000);
  avisoConexao.unref();
}

function iniciarBot() {
  if (encerrando) return;
  tentativaConexao++;
  const geracao = ++geracaoConexao;
  conexaoPronta = false;
  aguardandoQr = false;
  etapaConexao = 'abrindo o navegador do WhatsApp';
  console.log('Iniciando o bot: abrindo o navegador do WhatsApp...');
  programarLimiteConexao();
  client.initialize().catch(async (erro) => {
    if (geracao === geracaoConexao && !encerrando) await falharConexao(erro);
  });
}

iniciarBot();
