# Bot da Farmácia — WhatsApp

## Atendimento restaurado

Consultas e fluxos de agendamento restaurados a partir do backup anterior ao
encerramento. Saudações e agradecimentos não incluem mais o aviso do dia 05/10.
Para ativar, pare o processo anterior com `Ctrl+C` e execute `npm start`.
Os testes de `index.js` simulam as conversas e a conexão, sem serviços reais.

## Versão ativa: modelo enviado pelo usuário

O `index.js` foi substituído integralmente pelo código enviado em 22/09/2026.
Toda a lógica ativa está nesse arquivo; os módulos de `src/` não são carregados
por essa versão. As regras desse modelo substituem as alterações anteriores.

Para iniciar, execute `npm start`. A autenticação continua usando `.wwebjs_auth`.
As configurações estão diretamente no `index.js`: endereço da API, cache de
60 segundos, pendências de 5 minutos e atraso de resposta de 2 a 3,5 segundos.
Essa versão não carrega `.env`.

A cópia anterior de `index.js` e deste documento está em
`backups/antes-modelo-enviado-20260922-091956/`.

A sintaxe foi verificada com `node --check index.js`. Também foram simulados,
sem conexão ao WhatsApp ou à API, saudação, busca com erro de digitação, estoque,
cache, agendamento, silêncio para texto desconhecido, pergunta genérica,
agradecimento, escolha de dosagem e confirmação.
Os testes em `test/` verificam os módulos anteriores e os fluxos ativos de `index.js`.

## Documentação da implementação anterior

As instruções abaixo descrevem a versão modular anterior, preservada em `src/`.

Consulta o catálogo de medicamentos da farmácia e responde sobre disponibilidade.
O bot não orienta tratamentos, registra agendamentos ou encaminha pedidos automaticamente.

## Executar

Requer Node.js 24 ou superior e acesso à rede da API da farmácia.

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Revise os valores do `.env` antes de iniciar. Escaneie o QR code com o número
destinado ao bot. A sessão fica em `.wwebjs_auth` e é reutilizada nas próximas
execuções. Para parar, use `Ctrl+C`. Em falha de autenticação ou desconexão, o
processo informa o problema e termina com erro; verifique a conexão/sessão e
reinicie com `npm start`. Não há reconexão automática implementada.

## Configuração

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| `API_URL` | Endpoint interno indicado em `.env.example` | Catálogo de medicamentos |
| `API_TIMEOUT_MS` | `10000` | Tempo limite da requisição |
| `CACHE_DURACAO_MS` | `60000` | Validade do catálogo em memória |
| `SESSAO_DURACAO_MS` | `300000` | Validade de cada etapa da conversa |
| `RESPOSTA_DELAY_MS` | `0` | Atraso opcional antes de responder |

O `.env` é carregado pelo próprio Node.js. Variáveis já definidas no ambiente
têm prioridade. As durações devem ser inteiros positivos; o atraso permite zero.

## Comportamento

- Atende mensagens de texto individuais. Fotos, com ou sem legenda, recebem
  “Vou te encaminhar para o atendimento para que a equipe possa te ajudar. Aguarde
  só um instante 🙂”. Essa frase é exclusiva para fotos e pausa o bot para a equipe
  atender na própria conversa, sem analisar a imagem ou a legenda. Não repete o
  aviso enquanto o atendimento manual estiver ativo; `consultar` retoma o bot.
  Ignora grupos, status, mensagens próprias e outras mídias, como áudios e documentos.
  Observa mensagens enviadas pela equipe apenas para reconhecer o encerramento.
- Quando não entende um texto, pede o nome ou a dosagem e mantém a conversa ativa.
  Se houver confirmação ou escolha pendente, repete a pergunta ou as opções.
  Uma dosagem não encontrada mostra as apresentações cadastradas para a pessoa
  conferir. Dúvidas fora do escopo recebem orientação para falar com a equipe,
  sem bloquear novas consultas. Estoque desconhecido é explicado sem afirmar
  disponibilidade ou falta.
- Aceita nome comercial ou princípio ativo. Correspondências aproximadas pedem
  confirmação antes de informar disponibilidade.
- Prioriza correspondências exatas. Havendo várias apresentações, pede nome e
  dosagem completos e mostra até dez opções.
- Uma dosagem informada que não corresponda ao catálogo nunca é substituída
  silenciosamente. Combinações exigem todos os componentes, na mesma ordem.
  As unidades precisam coincidir quando informadas; não há conversão automática
  entre mg, mcg e g. Se omitida, a unidade não é usada como filtro.
- Uma mensagem contendo apenas dosagem pode sugerir um candidato, mas exige
  confirmação do nome. Números associados a comprimidos, caixas, dias ou anos
  não são usados como dosagem.
- “Não é esse” rejeita uma sugestão e pede outro nome, sem pausar o bot.
  “Obrigado, tem losartana?” e “Ok, tem
  losartana?” continuam sendo consultas. Confirmações curtas como “ok”, “tá bom”,
  “ok obrigado” e agradecimentos ou emojis isolados recebem: “Agradecemos por usar
  nosso serviço. Desejamos muita saúde para você. 🙂”, sem iniciar busca de medicamento.
  A despedida também funciona durante atendimento manual, mantendo a pausa do bot.
  Uma confirmação afirmativa de medicamento pendente, como “certo”, tem prioridade.
- O bot reconhece a mensagem enviada pela equipe no mesmo WhatsApp com “A nova
  data para pegar a sua medicação”, data, hora e referência ao comprovante. Esse
  modelo encerra pendências do paciente e cancela respostas ainda em preparo.
  Após o encerramento, mensagens sem medicamento identificado ficam em silêncio
  durante a validade da sessão. Uma nova consulta com nome de medicamento, uma
  saudação, `consultar` ou um novo pedido de agendamento podem retomar o atendimento.
  “Ok” e agradecimentos isolados recebem essa despedida mesmo após a sessão expirar.
  A detecção depende desse modelo de mensagem, com o bot conectado; não lê fotos
  nem recupera encerramentos enviados enquanto estava desligado.
- `cancelar`, `sair` e `encerrar` limpam a sessão. `consultar` inicia nova consulta.
- Ao pedir agendamento de um medicamento em falta, inclusive Tafamidis, o bot
  informa que não há previsão de chegada, que é possível agendar ou reagendar
  para quando chegar e que o paciente precisa verificar periodicamente, pois
  não há aviso automático. Essa regra tem prioridade sobre a coleta de dados.
- Para Tafamidis disponível, o bot pergunta se é a primeira retirada. Se for,
  solicita primeiro nome completo e depois data de nascimento em `DD/MM/AAAA`.
  Valida o formato dos dados e confirma apenas o recebimento nesta conversa;
  a equipe ainda precisa confirmar o agendamento. Não solicita CPF ou telefone.
  Se não for a primeira retirada, envia a mensagem de encaminhamento sem pedir esses dados.
- O agendamento usa o medicamento citado na mensagem ou a última consulta
  identificada dentro da sessão. O estoque é consultado novamente pelo cache
  antes de decidir o fluxo e durante a coleta de dados.
- Para os demais medicamentos disponíveis, o bot responde: “Entendi que você quer
  agendar. Já vou te encaminhar para o atendimento, aguarde só um instante 🙂”.
  A mesma mensagem vale para retirada recorrente de Tafamidis disponível.
  O encaminhamento consiste em pausar o bot para atendimento humano na própria
  conversa; não cria fila externa nem notifica automaticamente um atendente.
- Pedidos como “Quero agendar”, sem consulta anterior, com sessão expirada ou sem
  medicamento/disponibilidade identificados, também recebem essa mensagem de
  encaminhamento. A orientação de falta e o fluxo especial de Tafamidis continuam
  tendo prioridade quando o medicamento e o estoque são identificados.
  Após essa orientação ou o recebimento dos dados de primeira retirada, a automação
  pausa até `consultar`, `cancelar` ou a expiração da sessão.
- Mensagens do mesmo contato são processadas em ordem. Outros contatos podem
  ser atendidos simultaneamente. Sessões expiradas são removidas periodicamente.
- Falhas de consulta produzem aviso técnico sem prometer verificação manual.

## Contrato da API

O endpoint deve responder com uma lista JSON, por exemplo:

```json
[
  {
    "nome_medicamento": "Exemplo 50mg",
    "principio_ativo": "Exemplo",
    "em_falta": false
  }
]
```

`nome_medicamento` precisa ser texto não vazio. `principio_ativo` é opcional.
Somente valores booleanos de `em_falta` geram “Disponível” ou “Em falta”. Campos
ausentes, valores como `"false"` e registros duplicados com status conflitantes
geram “Disponibilidade não informada”. Listas ou nomes inválidos causam erro de
consulta. Requisições simultâneas compartilham a mesma consulta em andamento.
O cache expirado não é usado se a atualização falhar.

## Estrutura e validação

- `index.js`: configuração, conexão com WhatsApp e encerramento.
- `src/catalogo.js`: consulta HTTP, validação e cache.
- `src/medicamentos.js`: busca, dosagens e reconhecimento de frases.
- `src/atendimento.js`: fluxo, sessões e fila por contato.
- `test/`: testes automatizados com catálogo e mensagens simulados.

```powershell
npm test
npm run check
```

Os testes não conectam ao WhatsApp nem à API real. Antes do uso no número
oficial, valide o formato real do catálogo e os fluxos em um número de teste.
Disponibilidade pode refletir o cache de até um minuto por padrão.

## Dados locais

Não versione `.env`, `.wwebjs_auth`, `.wwebjs_cache`, `node_modules` ou logs;
o `.gitignore` já exclui esses caminhos. O projeto não cria banco de dados de
pacientes. As sessões ficam apenas em memória e desaparecem ao reiniciar.
Nome e data de nascimento enviados na primeira retirada ficam na conversa do
WhatsApp; o bot não os grava em banco, arquivos ou logs. As mensagens continuam
sujeitas ao armazenamento do próprio WhatsApp.
Não há integração com fila humana, confirmação de agendamento ou transcrição
de áudio. A dependência de transcrição foi retirada do projeto.
