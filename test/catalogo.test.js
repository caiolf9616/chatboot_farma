const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCatalogo, validarCatalogo } = require('../src/catalogo');

const item = { nome_medicamento: 'Losartana 50mg', em_falta: false };

test('API exige uma lista e nomes válidos', () => {
  for (const dados of [{ data: [] }, null, [null], [{}], [{ nome_medicamento: 12 }]]) {
    assert.throws(() => validarCatalogo(dados));
  }
  assert.deepEqual(validarCatalogo([]), []);
});

test('status ausente ou com tipo incorreto fica desconhecido', () => {
  const dados = validarCatalogo([item, { nome_medicamento: 'Segundo', em_falta: 'false' }, { nome_medicamento: 'Outro' }]);
  assert.deepEqual(dados.map(m => m.em_falta), [false, null, null]);
});

test('cadastros duplicados com estoques conflitantes ficam desconhecidos', () => {
  const dados = validarCatalogo([item, { ...item, em_falta: true }]);
  assert.equal(dados.length, 1);
  assert.equal(dados[0].em_falta, null);
});

test('requisições concorrentes compartilham consulta e respeitam timeout e cache', async () => {
  let chamadas = 0;
  let tempo = 0;
  const catalogo = criarCatalogo({ url: 'http://teste', agora: () => tempo, cacheMs: 100,
    timeoutMs: 2500, http: { async get(url, options) {
      chamadas++;
      assert.equal(url, 'http://teste');
      assert.equal(options.timeout, 2500);
      return { data: [item] };
    } } });
  await Promise.all([catalogo.buscarTodos(), catalogo.buscarTodos(), catalogo.buscarTodos()]);
  assert.equal(chamadas, 1);
  tempo = 99;
  await catalogo.buscarTodos();
  assert.equal(chamadas, 1);
  tempo = 100;
  await catalogo.buscarTodos();
  assert.equal(chamadas, 2);
});

test('falha após expiração não retorna estoque antigo e permite nova tentativa', async () => {
  let tempo = 0;
  let falhar = false;
  const catalogo = criarCatalogo({ agora: () => tempo, cacheMs: 100, http: { async get() {
    if (falhar) throw new Error('offline');
    return { data: [item] };
  } } });
  await catalogo.buscarTodos();
  tempo = 101;
  falhar = true;
  await assert.rejects(catalogo.buscarTodos(), /offline/);
  falhar = false;
  assert.equal((await catalogo.buscarTodos())[0].em_falta, false);
});
