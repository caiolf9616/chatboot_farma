const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function simular({ fechar = async () => {}, inicializar = async () => {} } = {}) {
  const eventos = new Map();
  const sinais = new Map();
  const timers = new Set();
  const estado = { inicios: 0, fechamentos: 0, saidas: [], erros: [] };
  class Client {
    constructor(opcoes) { estado.opcoes = opcoes; }
    on(nome, callback) { eventos.set(nome, callback); }
    async initialize() { estado.inicios++; await inicializar(); }
    async destroy() { estado.fechamentos++; await fechar(); }
  }
  const processo = {
    on(nome, callback) { sinais.set(nome, callback); },
    exit(codigo) { estado.saidas.push(codigo); }
  };
  vm.runInNewContext(codigo, {
    require(nome) {
      if (nome === 'whatsapp-web.js') return { Client, LocalAuth: class {} };
      if (nome === 'qrcode-terminal') return { generate() {} };
      if (nome === 'axios') return {};
      throw new Error(nome);
    },
    console: { log() {}, warn() {}, error(...args) { estado.erros.push(args.join(' ')); } },
    process: processo,
    setTimeout(callback, tempo) {
      const timer = { callback, tempo, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); }
  });
  return {
    estado, processo, timers,
    evento(nome, ...args) { return eventos.get(nome)(...args); },
    sinal(nome) { return sinais.get(nome)(); },
    async expirar() {
      const timer = [...timers].find(t => t.tempo === 60000);
      assert(timer, 'deve existir um limite de inicialização');
      timers.delete(timer);
      await timer.callback();
    }
  };
}

test('inicialização travada fecha o navegador anterior antes de tentar novamente', async () => {
  const bot = simular();
  bot.evento('authenticated');
  await bot.expirar();
  assert.equal(bot.estado.fechamentos, 1);
  assert.equal(bot.estado.inicios, 2);
  bot.evento('ready');
  assert.equal(bot.timers.size, 0);
});

test('duas tentativas travadas encerram com erro sem criar loop', async () => {
  const bot = simular();
  await bot.expirar();
  await bot.expirar();
  assert.equal(bot.estado.inicios, 2);
  assert.equal(bot.estado.fechamentos, 2);
  assert.equal(bot.processo.exitCode, 1);
  assert.equal(bot.timers.size, 0);
  assert(bot.estado.erros.some(e => e.includes('duas tentativas')));
});

test('aguarda QR sem reiniciar e volta a limitar o tempo após autenticar', async () => {
  const bot = simular();
  bot.evento('qr', 'qr-simulado');
  assert.equal(bot.timers.size, 0);
  bot.evento('authenticated');
  await bot.expirar();
  assert.equal(bot.estado.inicios, 2);
});

test('Ctrl+C fecha uma vez, cancela recuperação e desativa os handlers duplicados do navegador', async () => {
  const bot = simular();
  await bot.sinal('SIGINT');
  await bot.sinal('SIGINT');
  assert.equal(bot.estado.fechamentos, 1);
  assert.equal(bot.estado.inicios, 1);
  assert.equal(bot.timers.size, 0);
  assert.deepEqual(bot.estado.saidas, [0]);
  assert.equal(bot.estado.opcoes.puppeteer.handleSIGINT, false);
  assert.equal(bot.estado.opcoes.puppeteer.handleSIGTERM, false);
  assert.equal(bot.estado.opcoes.puppeteer.handleSIGHUP, false);
});

test('Ctrl+C durante recuperação compartilha o fechamento e não abre outro navegador', async () => {
  let liberar;
  const bot = simular({ fechar: () => new Promise(resolve => { liberar = resolve; }) });
  const recuperacao = bot.expirar();
  const encerramento = bot.sinal('SIGINT');
  liberar();
  await Promise.all([recuperacao, encerramento]);
  assert.equal(bot.estado.fechamentos, 1);
  assert.equal(bot.estado.inicios, 1);
  assert.deepEqual(bot.estado.saidas, [0]);
});
