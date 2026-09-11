# Uma instância de rate limit em três rotas = um balde só

**Sintoma.** Testando Cartão, requisições legítimas começavam a receber
429 muito antes do limite configurado.

**Causa raiz.** A **mesma** instância de `rateLimit(...)` foi reaproveitada
em três `app.use()` diferentes. Cada instância guarda o contador por
IP + caminho de montagem, então as três rotas somavam no mesmo balde de
60/min — o número escrito sugeria 60 por rota, e na prática eram 60 no
total.

**Correção.** Fábrica `criarLimitadorConsulta()` em `src/server.js`,
chamada uma vez por rota.

**Guarda.** O comentário no `server.js` explica por que é fábrica e não
constante — sem ele, a próxima pessoa "simplifica" de volta.

**Como evitar na origem.** Middleware com estado interno não é valor
reutilizável: é instância. Reaproveitar a mesma instância em montagens
diferentes compartilha o estado, e o sintoma aparece só sob carga.
