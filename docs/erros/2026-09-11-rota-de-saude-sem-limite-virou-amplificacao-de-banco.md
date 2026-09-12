# A rota de saúde sem limite virou amplificação de banco

**Sintoma.** Nenhum ainda. Achado no ciclo de segurança: `/api/saude`
era a única rota pública sem limitador, e cada chamada dispara uma
consulta real no Supabase.

**Causa raiz.** A consulta é **de propósito** — é ela que impede o
projeto gratuito do Supabase de ser pausado por inatividade, e por isso
uma verificação "barata" que só lesse variável de ambiente não serviria.
Com isso, a rota virou o caminho mais barato que existe para queimar a
quota do banco ou derrubar a instância: sem credencial, sem teto, uma ida
ao Supabase por requisição.

Todos os limitadores foram montados rota a rota, e a lista foi escrita
pensando em "onde se cria cobrança" e "onde se consulta pedido".
`/api/saude` não é nenhum dos dois, então nunca entrou na lista — e a
ausência não aparece em lugar nenhum, porque a rota responde 200.

Medido enquanto se testava: com o Supabase inalcançável, 17 chamadas
seguidas levaram cerca de dois minutos, cada uma segurando a conexão até
o timeout. A rota não só consulta, ela **espera**.

**Correção.** Limitador próprio de 30/min em `/api/saude`, e 300/min em
`/api/webhooks` (teto alto de propósito: a Asaas dispara em rajada e
**pausa a fila depois de 15 falhas consecutivas** — cortar evento
legítimo é pior que absorver sondagem).

**Guarda.** O comentário no `src/server.js` registra o número do cron
externo (6 chamadas por hora) ao lado do teto de 30, para que o próximo
que mexer veja a folga e o motivo dela.

**Como evitar na origem.** A pergunta não é "esta rota cria alguma
coisa?", é **"esta rota faz trabalho?"**. Rota pública que toca banco,
disco ou rede externa entra na lista de limites, mesmo que só devolva
`{status:'ok'}`. E a lista de rotas limitadas se confere contra a lista
de rotas montadas, não de memória.

**Ecossistema:** sim — todo projeto tem uma rota de saúde, quase toda
rota de saúde acaba consultando o banco para ser honesta, e ela é
sistematicamente esquecida na hora de aplicar limite, porque não parece
uma rota "de verdade".
