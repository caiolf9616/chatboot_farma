function normalizarTexto(texto) {
  return String(texto || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])\1{2,}/g, '$1')
    .replace(/[?!.,;:()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set(('tem vcs voces voce vc tera possui disponivel disponibilidade estoque o a de do da para pra ai esse essa isso ja chegou medicacao medicacoes medicamento medicamentos remedio remedios gostaria saber se bom boa dia tarde noite por favor ola oi com sem uma um ou e temos teria teriam me manda mandar preciso precisa queria quero qual quais obrigado obrigada obg valeu mesmo muito').split(' '));
// Expressões comuns e erros de escrita de "tem" não são nomes de medicamentos.
// A lista explícita evita interpretar palavras como "sem" como consulta de estoque.
const TERMOS_INFORMAIS_CONSULTA = new Set('ta tao tendo temm tam ten tme teem ces ceis pf pfv pfvr porfavor q keria sabe sabem'.split(' '));

function palavrasBusca(texto) {
  return normalizarTexto(texto).replace(/([a-z])(\d)|(\d)([a-z])/g, '$1$3 $2$4')
    .split(/\s+/).filter(p => p.length >= 3 && !STOPWORDS.has(p) && !TERMOS_INFORMAIS_CONSULTA.has(p) && !/\d/.test(p) &&
      !/^(mcg|ug|mg|g|ml|ui|l)$/.test(p));
}

function levenshtein(a, b) {
  const linha = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const atual = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1,
        anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = atual;
    }
  }
  return linha[b.length];
}

function pontuarPalavra(busca, alvo) {
  if (busca === alvo) return 1;
  if (Math.min(busca.length, alvo.length) < 4) return 0;
  if (busca.startsWith(alvo) || alvo.startsWith(busca)) return 0.9;
  const score = 1 - levenshtein(busca, alvo) / Math.max(busca.length, alvo.length);
  return score >= 0.75 ? score : 0;
}

function buscarPorNome(catalogo, texto) {
  const palavras = palavrasBusca(texto);
  if (!palavras.length) return [];
  const resultados = catalogo.map(med => {
    const alvos = normalizarTexto(`${med.nome_medicamento} ${med.principio_ativo || ''}`)
      .replace(/([a-z])(\d)|(\d)([a-z])/g, '$1$3 $2$4').split(/\s+/);
    let score = 0;
    for (const palavra of palavras) {
      for (const alvo of alvos) score = Math.max(score, pontuarPalavra(palavra, alvo));
    }
    return { ...med, _pontuacaoBusca: score };
  }).filter(med => med._pontuacaoBusca > 0)
    .sort((a, b) => b._pontuacaoBusca - a._pontuacaoBusca);
  // Uma correspondência exata deve prevalecer sobre nomes apenas parecidos.
  return resultados.some(med => med._pontuacaoBusca === 1)
    ? resultados.filter(med => med._pontuacaoBusca === 1) : resultados;
}

function extrairDosagem(texto) {
  const entrada = String(texto || '').toLowerCase().replace(/μ|µ/g, 'u');
  const regex = /\d+(?:[.,]\d+)?\s*((?:mcg|ug|mg|g|ml|ui|l)(?![a-z])|%)?/g;
  const partes = [];
  for (const match of entrada.matchAll(regex)) {
    const depois = entrada.slice(match.index + match[0].length);
    // Quantidade de embalagens, idade e duração não são dosagens.
    if (!match[1] && /^\s*(comprimidos?|capsulas?|caixas?|unidades?|dias?|anos?)\b/.test(depois)) continue;
    partes.push({ valor: Number(match[0].match(/\d+(?:[.,]\d+)?/)[0].replace(',', '.')),
      unidade: match[1] || null });
  }
  // Em "12/400 mcg", a unidade final vale para os dois componentes.
  const unidadeFinal = partes.at(-1)?.unidade;
  return partes.map(parte => ({ ...parte, unidade: parte.unidade || unidadeFinal || null }));
}

function medicamentoBateDosagem(nome, dosagem) {
  const alvo = extrairDosagem(nome);
  if (!dosagem.length || dosagem.length !== alvo.length) return false;
  return dosagem.every((parte, i) => {
    const outra = alvo[i];
    if (parte.unidade && parte.unidade !== outra.unidade) return false;
    return parte.valor === outra.valor;
  });
}

function formatarResposta(med) {
  if (typeof med.em_falta !== 'boolean') return `⚠️ ${med.nome_medicamento} — Disponibilidade não informada`;
  return `${med.em_falta ? '❌' : '✅'} ${med.nome_medicamento} — ${med.em_falta ? 'Em falta' : 'Disponível'}`;
}

function ehConfirmacaoAfirmativa(texto) {
  return new Set(['sim', 'e', 'isso', 'isso mesmo', 'esse mesmo', 'essa mesma',
    'exato', 'exatamente', 'correto', 'certo', 'positivo', 'isso ai', 'e isso mesmo',
    'e isso', 'e esse', 'e essa', 'sim obrigado', 'sim obrigada']).has(normalizarTexto(texto));
}

function ehSaudacao(texto) {
  return /^(?:(?:oi|oii|oie|ola|opa|bom dia|boa tarde|boa noite)\s*)+$/.test(normalizarTexto(texto));
}

function ehAgradecimento(texto) {
  return /^(?:(?:muito|mesmo|obrigado|obrigada|obg|obgd|valeu|brigado|brigada)\s*)+$/.test(normalizarTexto(texto));
}

function ehFimDeConversa(texto) {
  const msg = normalizarTexto(texto).replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '').trim();
  if (!msg) return /[\p{Extended_Pictographic}]/u.test(texto);
  return /^(?:(?:ok|okay|okey|blz|beleza|certo|ta|bom|tudo|bem|entendi|entendido|recebido|combinado|perfeito|obrigado|obrigada|obg|obgd|valeu|brigado|brigada|muito|mesmo|deus (?:te |lhe )?abencoe(?: (?:voce|voces))?)\s*)+$/.test(msg);
}

function ehMensagemFinalDaEquipe(texto) {
  const msg = normalizarTexto(texto).replace(/[*_~]/g, '').replace(/\s+/g, ' ');
  return /\b(?:a )?nova data para (?:pegar|retirar) (?:a )?(?:sua )?medicacao\b/.test(msg) &&
    /\bdata\s+\d{1,2}\/\d{1,2}\/\d{4}\b/.test(msg) &&
    /\bhora\s+\d{1,2}\s+\d{2}\b/.test(msg) && /\bcomprovante\b/.test(msg);
}

function ehAgendamento(texto) {
  return /\b(agendar|agendamento|reagendar|remarcar|marcar)\b/.test(normalizarTexto(texto));
}

function ehDuvidaForaDoEscopo(texto) {
  const msg = normalizarTexto(texto);
  return /\b(comprovantes?|receitas?|documentos?|atestados?|endereco|horario|horarios|atendente|atendimento humano|efeitos?|reacoes?|contraindicac\w*|posologia)\b/.test(msg) ||
    /\b(como|posso|pode|devo|deve|preciso) (?:\w+ ){0,3}(tomar|usar|misturar|substituir|trocar|retirar|buscar)\b/.test(msg) ||
    /\b(quantos|quantas|qual) (comprimidos|vezes|dose|dosagem)\b/.test(msg) ||
    /\bnao (?:quero|preciso|vou) (?:agendar|reagendar|marcar)\b/.test(msg);
}

function ehConsultaDisponibilidade(texto, candidatos) {
  if (!candidatos.length) return false;
  // Reconhecer uma palavra parecida com um remédio não basta para classificar
  // uma frase inteira como consulta de estoque. Outros assuntos vão à equipe.
  const termosConsulta = new Set(('tem tens vcs voces voce vc tera possui disponivel disponiveis disponibilidade estoque o os a as de do dos da das para pra ai esse esses essa essas isso ja chegou chegaram medicacao medicacoes medicamento medicamentos remedio remedios gostaria saber se bom boa dia tarde noite por favor ola oi com uma um e temos teria teriam preciso precisa queria quero qual quais obrigado obrigada obg valeu mesmo muito meu minha esta estao ainda hoje amanha mg mcg ug g ml ui l comprimido comprimidos capsula capsulas caixa caixas unidade unidades').split(' '));
  const nomes = candidatos.flatMap(med => palavrasBusca(`${med.nome_medicamento} ${med.principio_ativo || ''}`));
  const palavras = normalizarTexto(texto).replace(/([a-z])(\d)|(\d)([a-z])/g, '$1$3 $2$4')
    .replace(/[\d/+%*_~\-]/g, ' ').split(/\s+/).filter(Boolean);
  return palavras.every(palavra => /^(ok|okay|okey)$/.test(palavra) || termosConsulta.has(palavra) || TERMOS_INFORMAIS_CONSULTA.has(palavra) ||
    nomes.some(nome => pontuarPalavra(palavra, nome) > 0));
}

module.exports = { normalizarTexto, palavrasBusca, buscarPorNome, extrairDosagem,
  medicamentoBateDosagem, formatarResposta, ehConfirmacaoAfirmativa, ehSaudacao,
  ehAgradecimento, ehAgendamento, ehFimDeConversa, ehMensagemFinalDaEquipe,
  ehConsultaDisponibilidade, ehDuvidaForaDoEscopo };
