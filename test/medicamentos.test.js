const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarTexto, buscarPorNome, extrairDosagem, medicamentoBateDosagem,
  formatarResposta, ehConfirmacaoAfirmativa, ehAgradecimento } = require('../src/medicamentos');

test('normalização preserva números repetidos', () => {
  assert.equal(normalizarTexto('obrigadooo 1000'), 'obrigado 1000');
});

test('dosagem decimal aceita vírgula sem transformar 0,5 em 5', () => {
  assert.equal(medicamentoBateDosagem('Exemplo 0.5mg', extrairDosagem('0,5 mg')), true);
  assert.equal(medicamentoBateDosagem('Exemplo 5mg', extrairDosagem('0,5 mg')), false);
});

test('dosagens combinadas precisam de todos os componentes corretos', () => {
  assert.equal(medicamentoBateDosagem('Alenia 12/400mcg', extrairDosagem('12 400mcg')), true);
  assert.equal(medicamentoBateDosagem('Alenia 12/400mcg', extrairDosagem('6 400mcg')), false);
  assert.equal(medicamentoBateDosagem('Alenia 12/400mcg', extrairDosagem('400mcg')), false);
});

test('unidades diferentes não são tratadas como equivalentes', () => {
  assert.equal(medicamentoBateDosagem('Exemplo 50mg', extrairDosagem('50mcg')), false);
});

test('quantidade de comprimidos não vira concentração', () => {
  assert.equal(medicamentoBateDosagem('Losartana 50mg', extrairDosagem('Losartana 50mg 30 comprimidos')), true);
});

test('negações e frases ambíguas não confirmam candidatos', () => {
  for (const texto of ['não é esse', 'não, esse mesmo não', 'sim mas não é esse', 'é outro', 'esse mesmo? não']) {
    assert.equal(ehConfirmacaoAfirmativa(texto), false, texto);
  }
  assert.equal(ehConfirmacaoAfirmativa('é'), true);
  assert.equal(ehConfirmacaoAfirmativa('sim, obrigado'), true);
});

test('agradecimento acompanhado de pergunta não encerra conversa', () => {
  assert.equal(ehAgradecimento('obrigado, tem losartana?'), false);
  assert.equal(ehAgradecimento('muito obrigado!'), true);
});

test('ausência de estoque válido não significa disponibilidade', () => {
  assert.match(formatarResposta({ nome_medicamento: 'Exemplo' }), /não informada/);
  assert.match(formatarResposta({ nome_medicamento: 'Exemplo', em_falta: 'false' }), /não informada/);
});

test('busca exata prevalece sobre nomes parecidos, aceita nome junto da dose', () => {
  const catalogo = [{ nome_medicamento: 'Losartana 50mg' }, { nome_medicamento: 'Losartano 50mg' }];
  assert.deepEqual(buscarPorNome(catalogo, 'losartana50mg').map(m => m.nome_medicamento), ['Losartana 50mg']);
});
