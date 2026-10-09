const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercita o handler ativo sem conectar ao WhatsApp nem à API real.
const codigo = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const respostaPrevisao = 'Infelizmente não temos previsão 😔';

function criarBot(catalogoPersonalizado) {
  const eventos = new Map();
  let agora = Date.now();
  const catalogo = catalogoPersonalizado || [
    { nome_medicamento: 'Losartana 50mg', em_falta: true },
    { nome_medicamento: 'Tafamidis 61mg', em_falta: true },
    { nome_medicamento: 'Alenia 12/400mcg', em_falta: false }
  ];
  class Client {
    on(evento, handler) { eventos.set(evento, handler); }
    async initialize() {}
    async destroy() {}
  }
  class Relogio extends Date {
    static now() { return agora; }
  }
  vm.runInNewContext(codigo, {
    require(nome) {
      if (nome === 'whatsapp-web.js') return { Client, LocalAuth: class {} };
      if (nome === 'qrcode-terminal') return { generate() {} };
      if (nome === 'axios') return { get: async () => ({ data: catalogo }) };
      throw new Error(`Dependência inesperada: ${nome}`);
    },
    console: { log() {}, warn() {}, error() {} },
    process: { on() {} },
    Date: Relogio,
    setTimeout(callback, tempo) {
      if (tempo < 4000) callback();
      return { unref() {} };
    },
    clearTimeout() {}
  });
  return {
    avancar(tempo) { agora += tempo; },
    async enviar(body, from = 'contato-teste') {
      const respostas = [];
      await eventos.get('message')({
        body, from: `${from}@c.us`, type: 'chat',
        async reply(texto) { respostas.push(texto); }
      });
      return respostas;
    }
  };
}

test('saudação e agradecimento não anunciam encerramento e permitem consultar', async () => {
  const bot = criarBot();
  const saudacao = (await bot.enviar('Oi'))[0];
  assert.match(saudacao, /Qual medicamento/);
  assert.doesNotMatch(saudacao, /05\/10|ENCERRADO|98682/);
  assert.match((await bot.enviar('Tem alenia?'))[0], /Disponível/);
  const despedida = (await bot.enviar('Obrigado'))[0];
  assert.match(despedida, /Agradecemos/);
  assert.doesNotMatch(despedida, /05\/10|ENCERRADO|98682/);
  assert.match((await bot.enviar('Tem losartana?'))[0], /Em falta/);
});

test('responde previsão após informar medicamento em falta', async () => {
  for (const medicamento of ['losartana', 'tafamidis']) {
    const bot = criarBot();
    assert.match((await bot.enviar(`Tem ${medicamento}?`))[0], /Em falta/);
    for (const pergunta of [
      'Tem previsão?', 'tem previsao de chegar?', 'Quando chega?',
      'Quando vai voltar?', 'Qual o prazo de reposição?',
      'Obrigado, vocês têm previsão?'
    ]) {
      assert.deepEqual(await bot.enviar(pergunta), [respostaPrevisao]);
    }
  }
});

test('não presume falta quando não há consulta anterior ou o medicamento está disponível', async () => {
  const bot = criarBot();
  assert.deepEqual(await bot.enviar('Tem previsão?'), []);
  assert.match((await bot.enviar('Tem alenia?'))[0], /Disponível/);
  assert.deepEqual(await bot.enviar('Tem previsão?'), []);
});

test('mantém o contexto de previsão separado por contato e respeita sua expiração', async () => {
  const bot = criarBot();
  await bot.enviar('Tem losartana?', 'primeiro-contato');
  assert.deepEqual(await bot.enviar('Tem previsão?', 'outro-contato'), []);
  bot.avancar(5 * 60 * 1000);
  assert.deepEqual(await bot.enviar('Tem previsão?', 'primeiro-contato'), []);
});

test('uma nova consulta disponível substitui o contexto anterior de falta', async () => {
  const bot = criarBot();
  await bot.enviar('Tem losartana?');
  await bot.enviar('Tem alenia?');
  assert.deepEqual(await bot.enviar('Tem previsão?'), []);
});

test('pergunta o tipo ao pedir para marcar consulta e encaminha exame ou médico', async () => {
  for (const escolha of ['exame', 'para médico', 'consulta médica', '2', '3']) {
    const bot = criarBot();
    const pergunta = await bot.enviar('Quero marcar consulta');
    assert.equal(pergunta.length, 1);
    assert.match(pergunta[0], /1 - Medicação\n2 - Exame\n3 - Consulta com médico/);
    const respostas = await bot.enviar(escolha);
    assert.equal(respostas.length, 1);
    assert.match(respostas[0], /^Confira o novo número do Assistente Virtual 💬📲/);
    assert.match(respostas[0], /O \(85\) 98682-9000 é o canal oficial/);
    assert.match(respostas[0], /👉 “Quero falar com o Hospital de Messejana”/);
    for (const item of ['Marcação de exames', 'Marcação de consultas',
      'Funcionamento da Farmácia Ambulatorial', 'Horários de atendimento',
      'Regras para visitas e troca de acompanhantes', 'Acesso à Ouvidoria',
      'E muito mais!']) {
      assert(respostas[0].includes(`- ${item}`));
    }
    assert.match(respostas[0], /📲 Salve o número: \(85\) 98682-9000\n\nCompartilhe essa novidade!$/);
    assert.deepEqual(await bot.enviar('Tem previsão?'), []);
  }
});

test('escolher medicação pergunta o nome antes de consultar disponibilidade', async () => {
  for (const escolha of ['medicação', 'medicamentos', 'remédio', '1']) {
    const bot = criarBot();
    await bot.enviar('Quero marcar consulta');
    assert.deepEqual(await bot.enviar(escolha), [
      'Qual medicação você precisa receber? Informe o nome e, se souber, a dosagem.'
    ]);
  }
});

test('pedido explícito de exame ou médico tem prioridade sobre contexto de medicamento em falta', async () => {
  for (const pedido of ['Quero marcar exame', 'Quero agendar consulta médica']) {
    const bot = criarBot();
    await bot.enviar('Tem losartana?');
    assert.match((await bot.enviar(pedido))[0], /^Confira o novo número/);
  }
});

test('medicação em falta não solicita dados e mantém a resposta de previsão', async () => {
  const bot = criarBot();
  await bot.enviar('Tem losartana?');
  assert.match((await bot.enviar('Quero marcar consulta'))[0], /No momento o Losartana 50mg está em falta/);
  assert.deepEqual(await bot.enviar('Tem previsão?'), [respostaPrevisao]);
});

test('Entresto em falta seguido de agendar envia a orientação completa sem menu', async () => {
  for (const pedido of ['agendar', 'gostaria de marcar', 'quero reagendar', 'agendar medicação']) {
    const bot = criarBot([{ nome_medicamento: 'Entresto 200mg', em_falta: true }]);
    assert.match((await bot.enviar('Tem Entresto 200?'))[0], /Em falta/);
    assert.deepEqual(await bot.enviar(pedido), [
      'No momento o Entresto 200mg está em falta e não temos previsão de quando a medicação vai chegar. ' +
      'Podemos agendar ou reagendar para quando ela chegar, mas não temos como avisar automaticamente — ' +
      'você vai precisar ficar verificando com a gente periodicamente até que volte a ficar disponível.'
    ]);
  }
});

test('orientação de falta não usa contexto expirado, de outro contato ou estoque que voltou', async () => {
  const catalogo = [{ nome_medicamento: 'Entresto 200mg', em_falta: true }];
  const bot = criarBot(catalogo);
  await bot.enviar('Tem Entresto 200?', 'a');
  assert.match((await bot.enviar('agendar', 'b'))[0], /Você quer agendar para/);
  catalogo[0] = { nome_medicamento: 'Entresto 200mg', em_falta: false };
  bot.avancar(61000);
  assert.match((await bot.enviar('agendar', 'a'))[0], /Você quer agendar para/);
  assert.deepEqual(await bot.enviar('1', 'a'), [dadosAgendamento]);
  const expirado = criarBot();
  await expirado.enviar('Tem losartana?');
  expirado.avancar(5 * 60 * 1000);
  assert.match((await expirado.enviar('agendar'))[0], /Você quer agendar para/);
});

const dadosAgendamento = 'Para poder realizar o agendamento para receber o medicamento, preciso de alguns dados do paciente:\n\n' +
  '- Nome completo\n- Data de nascimento\n- Nome da mãe';

test('opção 1 aproveita o Alenia já consultado e pede os dados sem repetir a pergunta', async () => {
  const bot = criarBot();
  assert.match((await bot.enviar('medicação'))[0], /Quais medicações/);
  assert.match((await bot.enviar('Alenia 12\/400'))[0], /Alenia 12\/400mcg.*Disponível/);
  assert.match((await bot.enviar('Gostaria de marcar'))[0], /Você quer agendar para/);
  assert.deepEqual(await bot.enviar('1'), [dadosAgendamento]);
});

test('contexto expirado ou de outro contato continua perguntando a medicação', async () => {
  const bot = criarBot();
  await bot.enviar('Alenia 12/400', 'a');
  await bot.enviar('consulta', 'b');
  assert.match((await bot.enviar('1', 'b'))[0], /Qual medicação/);
  bot.avancar(5 * 60 * 1000);
  await bot.enviar('consulta', 'a');
  assert.match((await bot.enviar('1', 'a'))[0], /Qual medicação/);
});

test('reverifica estoque e não pede dados se a medicação passou a estar em falta', async () => {
  const catalogo = [{ nome_medicamento: 'Alenia 12/400mcg', em_falta: false }];
  const bot = criarBot(catalogo);
  await bot.enviar('Alenia 12/400');
  catalogo[0] = { nome_medicamento: 'Alenia 12/400mcg', em_falta: true };
  bot.avancar(61 * 1000);
  await bot.enviar('Gostaria de marcar');
  assert.match((await bot.enviar('1'))[0], /Alenia 12\/400mcg.*Em falta/);
  assert.deepEqual(await bot.enviar('Tem previsão?'), [respostaPrevisao]);
});

test('opção 1 consulta a medicação disponível e solicita exatamente os dados pedidos', async () => {
  const bot = criarBot();
  await bot.enviar('consulta');
  assert.match((await bot.enviar('1'))[0], /Qual medicação/);
  assert.deepEqual(await bot.enviar('alenia'), [dadosAgendamento]);
  assert.deepEqual(await bot.enviar('Paciente de Teste\n01/01/1990\nMãe de Teste'), [
    'Recebi sua mensagem. Aguarde o atendimento conferir os dados e confirmar o agendamento.'
  ]);
  assert.deepEqual(await bot.enviar('Complemento dos dados'), []);
});

test('agendamento resolve apresentação e não coleta dados para nome ou dosagem desconhecidos', async () => {
  const bot = criarBot([
    { nome_medicamento: 'Losartana 50mg', em_falta: false },
    { nome_medicamento: 'Losartana 100mg', em_falta: true }
  ]);
  await bot.enviar('consulta');
  await bot.enviar('1');
  assert.match((await bot.enviar('xyzabc'))[0], /Não consegui identificar/);
  assert.match((await bot.enviar('losartana'))[0], /mais de uma opção/);
  assert.match((await bot.enviar('200mg'))[0], /Não consegui identificar/);
  assert.deepEqual(await bot.enviar('50mg'), [dadosAgendamento]);
});

test('disponibilidade desconhecida não autoriza coleta e contexto não passa a outro contato', async () => {
  const bot = criarBot([{ nome_medicamento: 'Losartana 50mg' }]);
  await bot.enviar('consulta', 'a');
  await bot.enviar('1', 'a');
  assert.match((await bot.enviar('losartana', 'a'))[0], /Não consegui confirmar a disponibilidade/);
  assert.deepEqual(await bot.enviar('1', 'b'), []);
  await bot.enviar('cancelar', 'a');
  assert.deepEqual(await bot.enviar('1', 'a'), []);
});

test('nome aproximado pede confirmação antes de solicitar dados', async () => {
  const bot = criarBot();
  await bot.enviar('consulta');
  await bot.enviar('1');
  assert.match((await bot.enviar('aleniaa'))[0], /Você quis dizer/);
  assert.deepEqual(await bot.enviar('sim'), [dadosAgendamento]);
});

test('escolha indefinida pergunta novamente, permite cancelar e expira por contato', async () => {
  const bot = criarBot();
  await bot.enviar('Quero marcar consulta', 'a');
  assert.match((await bot.enviar('sim', 'a'))[0], /Você quer agendar para/);
  assert.deepEqual(await bot.enviar('2', 'b'), []);
  assert.deepEqual(await bot.enviar('cancelar', 'a'), ['Certo, cancelei a escolha do agendamento.']);
  assert.deepEqual(await bot.enviar('2', 'a'), []);
  await bot.enviar('Quero marcar consulta', 'a');
  bot.avancar(5 * 60 * 1000);
  assert.deepEqual(await bot.enviar('2', 'a'), []);
});

test('reconhece consulta curta, pedidos de número e erros comuns de digitação', async () => {
  for (const pedido of [
    'consulta', 'CONSULTAS?', 'marca consuta', 'cobsulta', 'consutla',
    'quero uma conssulta', 'qual numero da mrcaçao de consultas',
    'qual o telefone da marcação?', 'qual o zap para marcar consuta?',
    'como faço a marcacao', 'preciso de agendameto', 'quero agnedar consulta',
    'bom dia, como faz para remarcar a consulta?'
  ]) {
    const bot = criarBot();
    const respostas = await bot.enviar(pedido);
    assert.equal(respostas.length, 1, pedido);
    assert.match(respostas[0], /Você quer agendar para/, pedido);
    assert.match((await bot.enviar('médico'))[0], /^Confira o novo número/, pedido);
  }
});

test('reconhece destino médico ou exame já explícito nas variações', async () => {
  for (const pedido of ['consuta medica', 'marca consuta com médico',
    'qual numero da mrcaçao de exames', 'exames']) {
    const bot = criarBot();
    assert.match((await bot.enviar(pedido))[0], /^Confira o novo número/, pedido);
  }
});

test('consultar estoque e perguntar a marca não viram pedido de agendamento', async () => {
  for (const pedido of ['Quero consultar losartana', 'Tem losartana?',
    'Qual a marca da losartana?']) {
    const bot = criarBot();
    assert.match((await bot.enviar(pedido))[0], /Losartana 50mg.*Em falta/, pedido);
  }
});
