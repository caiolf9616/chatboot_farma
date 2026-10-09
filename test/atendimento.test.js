const test = require('node:test');
const assert = require('node:assert/strict');
const { criarAtendimento } = require('../src/atendimento');

const losartana = dose => ({ nome_medicamento: `Losartana ${dose}mg`, em_falta: false });
const DESPEDIDA = 'Agradecemos por usar nosso serviço.\nDesejamos muita saúde para você. 🙂\n' +
  'Agora pra saber informações sobre medicamentos ou agendamentos, o WhatsApp que deverá entrar em contato é (85) 98682-9000 ' +
  'e pedir para falar com a "Farmácia do Hospital de Messejana".\n' +
  'Pode acessar também clicando no link: https://api.whatsapp.com/send/?phone=5585986829000&text=Quero+falar+com+Hospital+de+Messejana&type=phone_number&app_absent=0\n' +
  'A partir de 05/10 esse número será ENCERRADO, não tendo mais atendimentos.';
const ATENDIMENTO = 'Vou te encaminhar para o atendimento para que a equipe possa te ajudar. Aguarde só um instante 🙂';
const PEDIR_MEDICAMENTO = 'Não consegui identificar sua consulta. Envie o nome do medicamento e, se souber, a dosagem. 🙂';
const RECUSA = 'Tudo bem! Envie novamente o nome do medicamento e, se souber, a dosagem. 🙂';
const FORA_ESCOPO = 'Posso consultar a disponibilidade de medicamentos. Para esse assunto, fale com a equipe da farmácia. ' +
  'Se quiser consultar o estoque, envie o nome do medicamento.';
const SEM_ESTOQUE_CONFIRMADO = 'Não consegui confirmar a disponibilidade desse medicamento no cadastro. ' +
  'Você pode tentar novamente mais tarde ou enviar o nome de outro medicamento.';

function verificarEsclarecimento(respostas, padrao = /nome|dosagem|equipe/) {
  assert.equal(respostas.length, 1);
  assert.notEqual(respostas[0], ATENDIMENTO);
  assert.doesNotMatch(respostas[0], /Disponível|Em falta/);
  assert.match(respostas[0], padrao);
}
function montar(dados = [losartana(50)], options = {}) {
  let itens = dados;
  let chamadas = 0;
  const respostas = [];
  const erros = [];
  const bot = criarAtendimento({ catalogo: { async buscarTodos() { chamadas++; return itens; } },
    logger: { error(...args) { erros.push(args); } }, ...options });
  return { bot, respostas, erros, trocar: novos => { itens = novos; }, chamadas: () => chamadas,
    async enviar(body, extra = {}) {
      const inicio = respostas.length;
      await bot.receber({ from: 'teste@c.us', type: 'chat', body,
        reply: async texto => { respostas.push(texto); }, ...extra });
      return respostas.slice(inicio);
    } };
}

test('agradecimento com bênção recebe despedida sem consultar o catálogo', async () => {
  for (const texto of ['Obrigada ☺️\nDeus abençoe', 'Obrigado, Deus te abençoe! 🙏',
    'Muito obrigada! Deus abençoe vocês', 'Deus abençoe']) {
    const app = montar();
    assert.deepEqual(await app.enviar(texto), [DESPEDIDA], texto);
    assert.equal(app.chamadas(), 0);
  }
});

test('bênção após agradecimento em mensagem separada também recebe despedida', async () => {
  const app = montar();
  assert.deepEqual(await app.enviar('Obrigada ☺️'), [DESPEDIDA]);
  assert.deepEqual(await app.enviar('Deus abençoe'), [DESPEDIDA]);
  assert.equal(app.chamadas(), 0);
});

test('agradecimento com bênção e pedido de atendimento não encerra conversa', async () => {
  const app = montar();
  assert.deepEqual(await app.enviar('Obrigada, Deus abençoe. Preciso de um atendente'), [FORA_ESCOPO]);
});

test('dosagem inexistente nunca responde disponível para outra dosagem', async () => {
  const app = montar();
  const [resposta] = await app.enviar('tem losartana 100mg?');
  assert.match(resposta, /Não encontrei a dosagem informada/);
  assert.doesNotMatch(resposta, /Disponível/);
  assert.match((await app.enviar('50'))[0], /Você quis dizer \*Losartana 50mg\*/);
  assert.deepEqual(await app.enviar('sim'), ['✅ Losartana 50mg — Disponível']);
});

test('combinação de dosagens diferente não informa estoque', async () => {
  const app = montar([{ nome_medicamento: 'Alenia 12/400mcg', em_falta: false }]);
  verificarEsclarecimento(await app.enviar('Alenia 6 400mcg'), /Não encontrei a dosagem informada/);
});

test('negativa após escolha de dosagem não confirma medicamento', async () => {
  const app = montar([losartana(25), losartana(50)]);
  assert.match((await app.enviar('losartana'))[0], /mais de uma opção/);
  assert.match((await app.enviar('25'))[0], /Você quis dizer/);
  const [resposta] = await app.enviar('não é esse');
  assert.doesNotMatch(resposta, /Disponível/);
  assert.equal(resposta, RECUSA);
});

test('confirmação é processada antes de saudações e usa estoque atualizado', async () => {
  const app = montar();
  assert.match((await app.enviar('50mg'))[0], /Você quis dizer/);
  app.trocar([{ ...losartana(50), em_falta: true }]);
  assert.match((await app.enviar('é'))[0], /Em falta/);
});

test('medicamento removido durante confirmação não usa registro antigo', async () => {
  const app = montar();
  await app.enviar('50mg');
  app.trocar([]);
  assert.deepEqual(await app.enviar('sim'), [SEM_ESTOQUE_CONFIRMADO]);
});

test('erro de digitação pede confirmação antes de mostrar estoque', async () => {
  const app = montar();
  const [resposta] = await app.enviar('losartanna');
  assert.match(resposta, /Você quis dizer \*Losartana 50mg\*/);
  assert.doesNotMatch(resposta, /Disponível|Em falta/);
  assert.match((await app.enviar('sim, obrigado'))[0], /Disponível/);
});

test('Estresto 100ml pede confirmação e explicita a diferença de unidade', async () => {
  for (const em_falta of [false, true]) {
    const app = montar([{ nome_medicamento: 'Entresto 100mg', em_falta }]);
    const [resposta] = await app.enviar('Estresto 100ml');
    assert.equal(resposta, 'Você quis dizer *Entresto 100mg*?\n' +
      'A unidade informada é diferente da cadastrada.\nResponda sim ou não.');
    app.trocar([{ nome_medicamento: 'Entresto 100mg', em_falta: !em_falta }]);
    assert.match((await app.enviar('sim'))[0], em_falta ? /Disponível/ : /Em falta/);
  }
});

test('nome curto com dose ou unidade digitada incorretamente continua como consulta', async () => {
  for (const texto of ['Estresto 100mg', 'Estresto100ml', 'Entresto 100ml', 'Estresto 100']) {
    const app = montar([{ nome_medicamento: 'Entresto 100mg', em_falta: false }]);
    const [resposta] = await app.enviar(texto);
    assert.match(resposta, /Você quis dizer \*Entresto 100mg\*/);
    assert.doesNotMatch(resposta, /Disponível|Em falta/);
    assert.doesNotMatch(resposta, /encaminhar/);
  }
});

test('erros de digitação em tem permitem consultar qualquer medicamento cadastrado', async () => {
  const nomes = ['Anoro', 'Losartana 50mg', 'Entresto 200mg'];
  for (const em_falta of [false, true]) {
    for (const nome of nomes) {
      for (const verbo of ['Tam', 'Ten', 'Tme', 'Teem']) {
        const app = montar(nomes.map(nome_medicamento => ({ nome_medicamento, em_falta })));
        const texto = `${verbo} o ${nome.toLowerCase()}?`;
        assert.deepEqual(await app.enviar(texto), [em_falta
          ? `❌ ${nome} — Em falta` : `✅ ${nome} — Disponível`], texto);
      }
    }
  }
});

test('erro em tem junto com erro no medicamento mantém a confirmação do nome', async () => {
  const app = montar([{ nome_medicamento: 'Anoro', em_falta: false }]);
  const [resposta] = await app.enviar('Tam o anoroo?');
  assert.match(resposta, /Você quis dizer \*Anoro\*/);
  assert.doesNotMatch(resposta, /Disponível|Em falta/);
  assert.deepEqual(await app.enviar('sim'), ['✅ Anoro — Disponível']);
});

test('erro em tem não adivinha medicamento, dosagem nem intenção de uso', async () => {
  for (const texto of ['Tam?', 'Tam o xyzabc?', 'Tam o anoro e posso usar?',
    'Tam losartana de 200?', 'Sem anoro', 'Não quero anoro']) {
    const app = montar([{ nome_medicamento: 'Anoro', em_falta: false }, losartana(50)]);
    verificarEsclarecimento(await app.enviar(texto));
  }
});

test('pergunta informal identifica Entresto 200 sem exigir a unidade', async () => {
  for (const em_falta of [false, true]) {
    for (const texto of ['Tem o entresto de 200 ', 'vcs tem entresto200?',
      'ta tendo entresto de 200 ai pfv', 'ces temm entresto de 200 porfavor']) {
      const app = montar([
        { nome_medicamento: 'Entresto 100mg', em_falta: !em_falta },
        { nome_medicamento: 'Entresto 200mg', em_falta }
      ]);
      assert.deepEqual(await app.enviar(texto), [em_falta
        ? '❌ Entresto 200mg — Em falta' : '✅ Entresto 200mg — Disponível'], texto);
    }
  }
});

test('pergunta informal com erro no nome sugere medicamento e mantém a dose', async () => {
  for (const texto of ['tem o entreso de 200 pfv', 'ta tendo estresto200 ai?',
    'vcs tem o entrestoo de 200']) {
    const app = montar([
      { nome_medicamento: 'Entresto 100mg', em_falta: true },
      { nome_medicamento: 'Entresto 200mg', em_falta: false }
    ]);
    const [resposta] = await app.enviar(texto);
    assert.match(resposta, /Você quis dizer \*Entresto 200mg\*/, texto);
    assert.doesNotMatch(resposta, /Disponível|Em falta/, texto);
    assert.doesNotMatch(resposta, /100mg|encaminhar/, texto);
    assert.deepEqual(await app.enviar('sim'), ['✅ Entresto 200mg — Disponível']);
  }
});

test('sabe se está tendo alemia sugere Alenia e consulta estoque após sim', async () => {
  for (const em_falta of [false, true]) {
    const nome_medicamento = 'Alenia 12/400mcg';
    const app = montar([{ nome_medicamento, em_falta: !em_falta }]);
    assert.deepEqual(await app.enviar('Sabe se está tendo alemia'), [
      'Você quis dizer *Alenia 12/400mcg*?\nResponda sim ou não.'
    ]);
    app.trocar([{ nome_medicamento, em_falta }]);
    assert.deepEqual(await app.enviar('sim'), [em_falta
      ? '❌ Alenia 12/400mcg — Em falta' : '✅ Alenia 12/400mcg — Disponível']);
  }
});

test('responder não rejeita Alenia sugerido sem informar disponibilidade', async () => {
  const app = montar([{ nome_medicamento: 'Alenia 12/400mcg', em_falta: false }]);
  assert.match((await app.enviar('Sabe se está tendo alemia'))[0], /Você quis dizer/);
  assert.deepEqual(await app.enviar('não'), [RECUSA]);
  assert.deepEqual(await app.enviar('sim'), [PEDIR_MEDICAMENTO]);
  assert.match((await app.enviar('Alenia 12/400mcg'))[0], /Disponível/);
});

test('sabe se está tendo também funciona com outros nomes e preserva ambiguidades', async () => {
  const app = montar([losartana(50)]);
  assert.deepEqual(await app.enviar('Vocês sabem se está tendo losartana?'), ['✅ Losartana 50mg — Disponível']);
  const ambiguo = montar([
    { nome_medicamento: 'Alenia 6/200mcg', em_falta: true },
    { nome_medicamento: 'Alenia 12/400mcg', em_falta: false }
  ]);
  const [resposta] = await ambiguo.enviar('Sabe se está tendo alemia');
  assert.match(resposta, /mais de uma opção/);
  assert.doesNotMatch(resposta, /Disponível|Em falta/);
});

test('sabe se com dúvida sobre uso orienta a procurar a equipe sem pausar consultas', async () => {
  const app = montar([{ nome_medicamento: 'Alenia 12/400mcg', em_falta: false }]);
  assert.deepEqual(await app.enviar('Sabe se posso usar alemia?'), [FORA_ESCOPO]);
  assert.match((await app.enviar('Alenia 12/400mcg'))[0], /Disponível/);
});

test('pergunta informal não usa outra dose quando a solicitada não existe', async () => {
  const app = montar([{ nome_medicamento: 'Entresto 100mg', em_falta: false }]);
  verificarEsclarecimento(await app.enviar('tem o entreso de 200 pfv'), /Não encontrei a dosagem informada/);
});

test('pergunta sem unidade pede escolha quando há apresentações ambíguas', async () => {
  const app = montar([
    { nome_medicamento: 'Exemplo 200mg', em_falta: false },
    { nome_medicamento: 'Exemplo 200ml', em_falta: true }
  ]);
  const [resposta] = await app.enviar('ta tendo exemplo de 200 pfv');
  assert.match(resposta, /mais de uma opção/);
  assert.doesNotMatch(resposta, /Disponível|Em falta/);
});

test('pedido informal sobre uso do medicamento não vira consulta de estoque', async () => {
  const app = montar([{ nome_medicamento: 'Entresto 200mg', em_falta: false }]);
  verificarEsclarecimento(await app.enviar('entresto de 200 faz mal pfv'));
});

test('sugestão não escolhe outra dosagem nem outra combinação numérica', async () => {
  for (const texto of ['Estresto 200ml', 'Estresto 100/50ml']) {
    const app = montar([{ nome_medicamento: 'Entresto 100mg', em_falta: false }]);
    verificarEsclarecimento(await app.enviar(texto), /Não encontrei a dosagem informada/);
  }
});

test('unidade correta tem prioridade e unidades ambíguas exigem escolha', async () => {
  const dados = [
    { nome_medicamento: 'Exemplo 100mg', em_falta: false },
    { nome_medicamento: 'Exemplo 100ml', em_falta: true }
  ];
  const app = montar(dados);
  assert.deepEqual(await app.enviar('Exemplo 100ml'), ['❌ Exemplo 100ml — Em falta']);
  const [resposta] = await app.enviar('Exemplo 100g');
  assert.match(resposta, /mais de uma opção/);
  assert.doesNotMatch(resposta, /Disponível|Em falta/);
});

test('recusar sugestão pede novo nome e permite outra consulta', async () => {
  const app = montar([{ nome_medicamento: 'Entresto 100mg', em_falta: false }]);
  await app.enviar('Estresto 100ml');
  assert.deepEqual(await app.enviar('não'), [RECUSA]);
  assert.deepEqual(await app.enviar('sim'), [PEDIR_MEDICAMENTO]);
  assert.match((await app.enviar('Entresto 100mg'))[0], /Disponível/);
});

test('unidade sozinha não identifica nome desconhecido', async () => {
  const app = montar([{ nome_medicamento: 'Exemplo 100mcg', em_falta: false }]);
  assert.deepEqual(await app.enviar('Xyzabc 100mcg'), [PEDIR_MEDICAMENTO]);
});

test('agradecimento com consulta é atendido', async () => {
  const app = montar();
  assert.match((await app.enviar('obrigado, tem losartana?'))[0], /Losartana 50mg — Disponível/);
});

test('mensagem com novo medicamento substitui candidatos pendentes', async () => {
  const app = montar([losartana(25), losartana(50), { nome_medicamento: 'Exemplo 25mg', em_falta: true }]);
  await app.enviar('losartana');
  assert.match((await app.enviar('Exemplo 25mg'))[0], /Exemplo 25mg — Em falta/);
});

test('Quero agendar sem consulta anterior envia encaminhamento e pausa o bot', async () => {
  const app = montar();
  assert.deepEqual(await app.enviar('Quero agendar'), [
    'Entendi que você quer agendar. Já vou te encaminhar para o atendimento, aguarde só um instante 🙂'
  ]);
  assert.deepEqual(await app.enviar('certo'), [DESPEDIDA]);
  assert.deepEqual(await app.enviar('tem losartana?'), []);
});

test('agendamento após expirar consulta anterior também envia encaminhamento', async () => {
  let tempo = 0;
  const app = montar(undefined, { agora: () => tempo, ttlMs: 100 });
  await app.enviar('losartana');
  tempo = 101;
  assert.deepEqual(await app.enviar('Quero agendar'), [
    'Entendi que você quer agendar. Já vou te encaminhar para o atendimento, aguarde só um instante 🙂'
  ]);
});

test('agendamento de medicamento disponível envia mensagem e pausa para atendimento', async () => {
  const app = montar();
  await app.enviar('losartana');
  const [resposta] = await app.enviar('quero agendar');
  assert.equal(resposta, 'Entendi que você quer agendar. Já vou te encaminhar para o atendimento, aguarde só um instante 🙂');
  assert.doesNotMatch(resposta, /CPF|data de nascimento|nome completo/);
  assert.deepEqual(await app.enviar('não quero informar'), []);
  assert.deepEqual(await app.enviar('dados pessoais fictícios'), []);
  await app.enviar('consultar');
  assert.match((await app.enviar('losartana'))[0], /Disponível/);
});

test('agendamento de qualquer medicamento em falta usa a mensagem solicitada', async () => {
  for (const nome of ['Losartana 50mg', 'Tafamidis 61mg', 'Alenia 12/400mcg', 'Entresto 200mg']) {
    const app = montar([{ nome_medicamento: nome, em_falta: true }]);
    await app.enviar(nome);
    assert.deepEqual(await app.enviar('quero agendar'), [
      `No momento o *${nome}* está em falta e não temos previsão de quando a medicação vai chegar. ` +
      'Podemos agendar ou reagendar para quando ela chegar, mas não temos como avisar automaticamente — ' +
      'você vai precisar ficar verificando com a gente periodicamente até que volte a ficar disponível.'
    ]);
    assert.deepEqual(await app.enviar('sim'), []);
  }
});

test('medicamento citado no agendamento prevalece sobre consulta anterior', async () => {
  const app = montar([losartana(50), { nome_medicamento: 'Tafamidis 61mg', em_falta: true }]);
  await app.enviar('losartana');
  assert.match((await app.enviar('quero agendar tafamidis'))[0], /\*Tafamidis 61mg\* está em falta/);
});

test('agendamento atualiza estoque antes de decidir o fluxo especial', async () => {
  const app = montar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: false }]);
  await app.enviar('tafamidis');
  app.trocar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: true }]);
  assert.match((await app.enviar('quero reagendar'))[0], /está em falta/);
});

test('primeira retirada de Tafamidis disponível pede nome completo e nascimento', async () => {
  const app = montar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: false }]);
  await app.enviar('tafamidis');
  assert.match((await app.enviar('quero marcar'))[0], /primeira vez/);
  assert.match((await app.enviar('talvez'))[0], /Responda sim ou não/);
  const [pedido] = await app.enviar('sim');
  assert.match(pedido, /nome completo e da sua data de nascimento/);
  assert.doesNotMatch(pedido, /CPF|telefone/);
  for (const invalido of ['não quero informar', '12345', 'Ana']) {
    assert.match((await app.enviar(invalido))[0], /nome e sobrenome/);
  }
  assert.match((await app.enviar('Ana Maria Silva'))[0], /data de nascimento/);
  for (const data of ['31/02/2000', '29/02/2001', '01/01/2999', '01/01/0000', 'ontem']) {
    assert.match((await app.enviar(data))[0], /data válida/);
  }
  const [resposta] = await app.enviar('29/02/2000');
  assert.match(resposta, /Recebi seu nome completo e sua data de nascimento nesta conversa/);
  assert.match(resposta, /ainda precisa ser confirmado/);
  assert.doesNotMatch(resposta, /dados foram registrados|agendamento confirmado/);
  assert.deepEqual(await app.enviar('obrigado'), [DESPEDIDA]);
});

test('retirada recorrente de Tafamidis não pede dados de primeira retirada', async () => {
  const app = montar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: false }]);
  await app.enviar('quero agendar tafamidis');
  const [resposta] = await app.enviar('não');
  assert.equal(resposta, 'Entendi que você quer agendar. Já vou te encaminhar para o atendimento, aguarde só um instante 🙂');
  assert.doesNotMatch(resposta, /envie seu nome|data de nascimento/);
});

test('Tafamidis sem disponibilidade confirmada não pede dados', async () => {
  const app = montar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: null }]);
  const [resposta] = await app.enviar('quero agendar tafamidis');
  assert.equal(resposta, 'Entendi que você quer agendar. Já vou te encaminhar para o atendimento, aguarde só um instante 🙂');
  assert.doesNotMatch(resposta, /primeira vez|envie seu nome/);
});

test('falta de estoque durante fluxo de Tafamidis interrompe coleta', async () => {
  const app = montar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: false }]);
  await app.enviar('quero agendar tafamidis');
  await app.enviar('sim');
  app.trocar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: true }]);
  const [resposta] = await app.enviar('Ana Maria Silva');
  assert.match(resposta, /está em falta/);
  assert.doesNotMatch(resposta, /data de nascimento/);
});

test('cancelar encerra coleta de Tafamidis e permite nova consulta', async () => {
  const app = montar([{ nome_medicamento: 'Tafamidis 61mg', em_falta: false }, losartana(50)]);
  await app.enviar('quero agendar tafamidis');
  await app.enviar('sim');
  await app.enviar('cancelar');
  assert.match((await app.enviar('losartana'))[0], /Losartana 50mg — Disponível/);
});

test('agradecer ou cancelar limpa a confirmação pendente', async () => {
  for (const texto of ['obrigado', 'cancelar']) {
    const app = montar();
    await app.enviar('50mg');
    await app.enviar(texto);
    const respostas = await app.enviar('sim');
    assert.ok(respostas.every(resposta => !resposta.includes('Disponível')));
  }
});

const FINAL_DA_EQUIPE = 'A nova data para pegar a sua medicação é: Data: 21/09/2026 Hora: 13:00\n\n' +
  'Pedimos que confira o comprovante que será enviado e compareça na data informada.\n\n' +
  'Não esqueça de trazer o comprovante impresso ou no celular.\n\n' +
  'Qualquer dúvida, estamos a disposição.';

function finalizarPelaEquipe(app, extra = {}) {
  app.bot.observarMensagemEnviada({ fromMe: true, from: 'farmacia@c.us',
    to: 'teste@c.us', type: 'chat', body: FINAL_DA_EQUIPE, ...extra });
}

test('agradecimentos e emojis isolados recebem despedida sem buscar medicamento', async () => {
  const app = montar();
  for (const texto of ['Ok obrigado', 'Tá bom', 'entendi', 'obrigada', 'obg', '👍', '👍🏽', '🙏 obrigada']) {
    assert.deepEqual(await app.enviar(texto), [DESPEDIDA], texto);
  }
  assert.equal(app.chamadas(), 0);
});

test('foto recebe encaminhamento e ok enviado separado continua em silêncio', async () => {
  const app = montar();
  assert.deepEqual(await app.enviar('ok', { type: 'image', hasMedia: true }), [ATENDIMENTO]);
  assert.deepEqual(await app.enviar('comprovante', { hasMedia: true }), []);
  for (const texto of ['ok', 'OK', 'Ok!', ' ok. ', 'okay', 'okey']) {
    assert.deepEqual(await app.enviar(texto), [], texto);
  }
  assert.equal(app.chamadas(), 0);
});

test('foto com ou sem legenda recebe a frase reservada sem consultar medicamentos', async () => {
  for (const body of ['', undefined, 'tem losartana?', 'sim', 'cancelar', 'consultar']) {
    const app = montar();
    assert.deepEqual(await app.enviar(body, { type: 'image', hasMedia: true }), [ATENDIMENTO]);
    assert.equal(app.chamadas(), 0);
  }
});

test('fotos em grupos, status e mensagens próprias são ignoradas', async () => {
  for (const extra of [{ from: 'grupo@g.us' }, { from: 'status@broadcast' },
    { isStatus: true }, { fromMe: true }]) {
    const app = montar();
    assert.deepEqual(await app.enviar('', { type: 'image', hasMedia: true, ...extra }), []);
    assert.deepEqual(await app.enviar('losartana'), ['✅ Losartana 50mg — Disponível']);
  }
});

test('foto pausa uma confirmação e não repete encaminhamento durante atendimento manual', async () => {
  const app = montar();
  await app.enviar('losartanna');
  const chamadas = app.chamadas();
  assert.deepEqual(await app.enviar('', { type: 'image', hasMedia: true }), [ATENDIMENTO]);
  assert.deepEqual(await app.enviar('sim'), []);
  assert.deepEqual(await app.enviar('', { type: 'image', hasMedia: true }), []);
  assert.deepEqual(await app.enviar('losartana'), []);
  assert.equal(app.chamadas(), chamadas);
  assert.match((await app.enviar('consultar'))[0], /^Olá\.\nAgora pra saber informações/);
  assert.deepEqual(await app.enviar('losartana'), ['✅ Losartana 50mg — Disponível']);
});

test('texto que menciona foto não envia a mensagem reservada para imagens', async () => {
  const app = montar();
  assert.deepEqual(await app.enviar('vou mandar uma foto'), [PEDIR_MEDICAMENTO]);
  assert.deepEqual(await app.enviar('losartana'), ['✅ Losartana 50mg — Disponível']);
});

test('resposta não compreendida mantém a confirmação para a próxima mensagem', async () => {
  const app = montar();
  await app.enviar('losartanna');
  const [resposta] = await app.enviar('acho que é');
  assert.match(resposta, /Você quis dizer \*Losartana 50mg\*/);
  assert.match(resposta, /Responda sim ou não/);
  assert.notEqual(resposta, ATENDIMENTO);
  assert.doesNotMatch(resposta, /Disponível|Em falta/);
  assert.deepEqual(await app.enviar('sim'), ['✅ Losartana 50mg — Disponível']);
});

test('esclarecimento mantém opções pendentes sem buscar outra medicação pela dose', async () => {
  const app = montar([losartana(25), losartana(50), { nome_medicamento: 'Outro 25mg', em_falta: true }]);
  await app.enviar('losartana');
  const [resposta] = await app.enviar('não entendi');
  assert.match(resposta, /mais de uma opção/);
  assert.doesNotMatch(resposta, /Outro|Disponível|Em falta/);
  assert.match((await app.enviar('25'))[0], /Você quis dizer \*Losartana 25mg\*/);
  assert.deepEqual(await app.enviar('sim'), ['✅ Losartana 25mg — Disponível']);
});

test('texto longo recebe orientação e permite consulta posterior', async () => {
  const app = montar();
  assert.deepEqual(await app.enviar('x'.repeat(1001)), [PEDIR_MEDICAMENTO]);
  assert.equal(app.chamadas(), 0);
  assert.deepEqual(await app.enviar('losartana'), ['✅ Losartana 50mg — Disponível']);
});

test('mensagem final enviada pela equipe encerra pendências no contato de destino', async () => {
  const app = montar();
  await app.enviar('50mg');
  finalizarPelaEquipe(app);
  const chamadas = app.chamadas();
  assert.deepEqual(await app.enviar('ok obrigado'), [DESPEDIDA]);
  assert.equal(app.chamadas(), chamadas);
  assert.deepEqual(await app.enviar('sim'), []);
  assert.deepEqual(await app.enviar('comprovante recebido'), []);
  assert.match((await app.enviar('tem losartana?'))[0], /Disponível/);
});

test('encerramento de um contato não interfere na confirmação de outro', async () => {
  const app = montar();
  await app.enviar('50mg');
  finalizarPelaEquipe(app, { to: 'outro@c.us' });
  assert.match((await app.enviar('sim'))[0], /Disponível/);
});

test('observador ignora mensagens recebidas, respostas comuns do bot e grupos', async () => {
  for (const extra of [{ fromMe: false }, { body: 'Você quis dizer Losartana 50mg?' },
    { to: 'grupo@g.us' }, { isStatus: true }, { body: 'Qualquer dúvida, estamos à disposição.' }]) {
    const app = montar();
    await app.enviar('50mg');
    finalizarPelaEquipe(app, extra);
    assert.match((await app.enviar('sim'))[0], /Disponível/);
  }
});

test('confirmações tardias recebem despedida mesmo após expirar o estado', async () => {
  let tempo = 0;
  const app = montar(undefined, { agora: () => tempo, ttlMs: 100 });
  finalizarPelaEquipe(app);
  tempo = 101;
  app.bot.limparExpirados();
  assert.deepEqual(await app.enviar('ok, obrigado!'), [DESPEDIDA]);
  assert.equal(app.chamadas(), 0);
});

test('ok acompanhado de nova pergunta continua sendo atendido', async () => {
  const app = montar();
  finalizarPelaEquipe(app);
  assert.match((await app.enviar('ok, tem losartana?'))[0], /Disponível/);
});

test('mensagem final da equipe cancela resposta automática ainda em preparo', async () => {
  let liberar;
  let sinalizar;
  const atraso = new Promise(resolve => { liberar = resolve; });
  const iniciou = new Promise(resolve => { sinalizar = resolve; });
  const app = montar(undefined, { esperar: () => { sinalizar(); return atraso; } });
  const resposta = app.enviar('losartana');
  await iniciou;
  finalizarPelaEquipe(app);
  liberar();
  assert.deepEqual(await resposta, []);
  assert.deepEqual(await app.enviar('obrigado'), [DESPEDIDA]);
});

test('certo ainda confirma o medicamento quando há uma pergunta pendente', async () => {
  const app = montar();
  await app.enviar('50mg');
  assert.match((await app.enviar('certo'))[0], /Disponível/);
});

test('sessões expiram sem reutilizar confirmação antiga', async () => {
  let tempo = 0;
  const app = montar(undefined, { agora: () => tempo, ttlMs: 100 });
  await app.enviar('50mg');
  tempo = 101;
  app.bot.limparExpirados();
  assert.deepEqual(await app.enviar('sim'), [PEDIR_MEDICAMENTO]);
});

test('textos não compreendidos recebem orientação e não pausam a conversa', async () => {
  for (const texto of ['Pode mandar o comprovante', 'Pode mandar o comprovante da medicação',
    'Preciso da receita do medicamento', 'Estou esperando', 'Meu nome é Ana Maria',
    '21/09/2026', '12345678900', 'sim', 'Pode enviar por aqui?', 'Preciso falar com vocês']) {
    const app = montar();
    verificarEsclarecimento(await app.enviar(texto));
    verificarEsclarecimento(await app.enviar(texto));
    assert.deepEqual(await app.enviar('losartana'), ['✅ Losartana 50mg — Disponível']);
  }
});

test('consulta não identificada pede o nome do medicamento', async () => {
  for (const texto of ['Quero consultar um medicamento', 'Remédio desconhecido', 'Xyzabc 10mg']) {
    const app = montar();
    assert.deepEqual(await app.enviar(texto), [PEDIR_MEDICAMENTO], texto);
    assert.deepEqual(await app.enviar('losartana'), ['✅ Losartana 50mg — Disponível']);
  }
});

test('pedido de comprovante orienta e limpa confirmação pendente sem pausar consultas', async () => {
  const app = montar();
  await app.enviar('losartanna');
  assert.deepEqual(await app.enviar('Pode mandar o comprovante'), [FORA_ESCOPO]);
  assert.deepEqual(await app.enviar('sim'), [PEDIR_MEDICAMENTO]);
  assert.match((await app.enviar('losartana'))[0], /Losartana 50mg — Disponível/);
});

test('consulta genérica sobre retirada pede detalhes sem inventar dosagem', async () => {
  for (const texto of [
    'Meu medicamento está agendado pra manhã só quero saber se tem as medicações pra não dá a viagem perdida',
    'Meu medicamento está agendado para 21/09 às 8h, tem as medicações para não perder a viagem?'
  ]) {
    const app = montar([losartana(50), { nome_medicamento: 'Viagem 10mg', em_falta: false }]);
    assert.deepEqual(await app.enviar(texto), [PEDIR_MEDICAMENTO]);
    assert.deepEqual(await app.enviar('tem losartana?'), ['✅ Losartana 50mg — Disponível']);
    assert.deepEqual(await app.enviar('ok'), []);
  }
});

test('dúvida fora do escopo não informa estoque e permite consulta posterior', async () => {
  for (const texto of ['Como tomar losartana 50mg?', 'Losartana causa sono?',
    'Pode mandar o comprovante da losartana?', 'Qual a dosagem da losartana?',
    'Tem losartana e posso tomar junto com outro remédio?', 'Quero agendar e preciso da receita',
    'Qual a data da consulta?', 'Não quero agendar, preciso de ajuda']) {
    const app = montar();
    verificarEsclarecimento(await app.enviar(texto));
    assert.deepEqual(await app.enviar('tem losartana?'), ['✅ Losartana 50mg — Disponível']);
  }
});

test('consulta clara de disponibilidade continua automática', async () => {
  for (const texto of ['Losartana 50mg', 'Tem losartana 50mg?',
    'Gostaria de saber se a losartana está disponível', 'Vocês têm losartana hoje?']) {
    const app = montar();
    assert.match((await app.enviar(texto))[0], /Losartana 50mg — Disponível/, texto);
  }
});

test('nova dúvida após encerramento recebe orientação', async () => {
  const app = montar();
  finalizarPelaEquipe(app);
  assert.deepEqual(await app.enviar('Como faço para pegar o comprovante?'), [FORA_ESCOPO]);
});

test('estoque sem informação confiável é explicado sem pausar consultas', async () => {
  const app = montar([{ ...losartana(50), em_falta: null }]);
  assert.deepEqual(await app.enviar('tem losartana?'), [SEM_ESTOQUE_CONFIRMADO]);
  app.trocar([losartana(50)]);
  assert.deepEqual(await app.enviar('tem losartana?'), ['✅ Losartana 50mg — Disponível']);
});

test('ignora grupos, status, mensagens próprias e mídias que não são fotos', async () => {
  const app = montar();
  for (const extra of [{ from: 'grupo@g.us' }, { isStatus: true }, { fromMe: true },
    { from: 'status@broadcast' }, { type: 'ptt' }, { type: 'audio' },
    { type: 'video' }, { type: 'document' }, { type: 'sticker' }]) {
    assert.deepEqual(await app.enviar('losartana', extra), []);
  }
  assert.equal(app.chamadas(), 0);
});

test('mensagens do mesmo contato aguardam o envio anterior, outros contatos seguem', async () => {
  const app = montar([losartana(25), losartana(50)]);
  let liberar;
  let sinalizar;
  const bloqueio = new Promise(resolve => { liberar = resolve; });
  const iniciou = new Promise(resolve => { sinalizar = resolve; });
  const primeira = app.enviar('losartana', { reply: async () => { sinalizar(); await bloqueio; } });
  await iniciou;
  const segunda = app.enviar('25');
  const terceira = app.enviar('sim');
  assert.deepEqual(app.respostas, []);
  const outro = await app.enviar('bom dia', { from: 'outro@c.us' });
  assert.match(outro[0], /^Olá\.\nAgora pra saber informações/);
  liberar();
  await Promise.all([primeira, segunda, terceira]);
  assert.match(app.respostas[1], /Você quis dizer/);
  assert.match(app.respostas[2], /Losartana 25mg — Disponível/);
});

test('falha na API não promete verificação manual', async () => {
  const app = montar(undefined, { catalogo: { async buscarTodos() { throw new Error('offline'); } } });
  const [resposta] = await app.enviar('losartana');
  assert.match(resposta, /problema técnico/);
  assert.doesNotMatch(resposta, /Vou verificar/);
  assert.equal(app.erros.length, 1);
});

test('falha no envio do aviso não rejeita a fila e permite continuar', async () => {
  const app = montar();
  await assert.doesNotReject(app.enviar('bom dia', { reply: async () => { throw new Error('offline'); } }));
  assert.equal(app.erros.length, 2);
  assert.match((await app.enviar('losartana'))[0], /Disponível/);
});
