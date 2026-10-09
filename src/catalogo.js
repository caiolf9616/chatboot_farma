function validarCatalogo(dados) {
  if (!Array.isArray(dados)) throw new Error('Formato inválido do catálogo');
  const medicamentos = new Map();
  for (const med of dados) {
    if (!med || typeof med.nome_medicamento !== 'string' || !med.nome_medicamento.trim()) {
      throw new Error('Medicamento sem nome válido no catálogo');
    }
    const item = {
      nome_medicamento: med.nome_medicamento.trim(),
      principio_ativo: typeof med.principio_ativo === 'string' ? med.principio_ativo : '',
      em_falta: typeof med.em_falta === 'boolean' ? med.em_falta : null
    };
    const chave = item.nome_medicamento.toLowerCase();
    const anterior = medicamentos.get(chave);
    if (anterior && anterior.em_falta !== item.em_falta) anterior.em_falta = null;
    else if (!anterior) medicamentos.set(chave, item);
  }
  return [...medicamentos.values()];
}

function criarCatalogo({ http, url, timeoutMs = 10000, cacheMs = 60000, agora = Date.now }) {
  let cache;
  let atualizadoEm = 0;
  let emAndamento;
  async function buscarTodos() {
    if (cache && agora() - atualizadoEm < cacheMs) return cache;
    if (!emAndamento) {
      emAndamento = (async () => {
        const resposta = await http.get(url, { timeout: timeoutMs });
        const dados = validarCatalogo(resposta.data);
        cache = dados;
        atualizadoEm = agora();
        return cache;
      })().finally(() => { emAndamento = null; });
    }
    return emAndamento;
  }
  return { buscarTodos };
}

module.exports = { criarCatalogo, validarCatalogo };
