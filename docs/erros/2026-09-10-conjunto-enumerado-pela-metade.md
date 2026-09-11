# Conjunto enumerado pela metade

**Sintoma.** A entrada da Vitrina ADS obrigou a mexer no checkout, que se
achava pronto. Um plano semanal exibia a palavra "weekly", em inglês, ao
comprador brasileiro. Eventos de pagamento chegavam e o pedido ficava
pendente para sempre do lado do contratante, sem ninguém saber por quê.

**Causa raiz.** O checkout conhecia **um pedaço** de domínios que a Asaas
define inteiros. Ciclos de assinatura: 4 dos 7. Status de cobrança: 5 dos
13 eventos que importam. Cada projeto novo que usasse um valor fora do
pedaço forçava uma atualização — e a atualização parecia "requisito novo",
quando era dívida antiga aparecendo.

**Correção.** Enumerar o conjunto inteiro nos dois lados
(`CICLOS_VALIDOS` em `src/controllers/asaasCheckoutController.js`,
`ROTULOS_CICLO` em `public/js/modules/assinaturaHandler.js`, e as listas
de evento em `src/controllers/webhookController.js`), com comentário
marcando que são espelhos um do outro.

**Guarda.** `pedidoService.js` e o controller validam o valor recebido e
recusam com 400 nomeando os aceitos, em vez de repassar valor
desconhecido para a Asaas.

**Como evitar na origem.** **Onde a Asaas define um conjunto fechado, o
checkout conhece o conjunto INTEIRO** — não o pedaço que o projeto da vez
usa. Antes de enumerar qualquer coisa vinda de terceiro, ler a definição
completa na documentação dele, não a lista de valores que apareceram até
agora.

**Ecossistema:** sim — todo projeto que integra um terceiro enumera algum conjunto fechado dele (status, moeda, tipo de documento, ciclo). Conhecer só o pedaço que o projeto da vez usa é a forma padrão de criar dívida que volta como "requisito novo".
