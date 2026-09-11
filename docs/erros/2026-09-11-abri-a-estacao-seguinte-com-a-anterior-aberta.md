# Abri a estação seguinte com a anterior aberta, e chamei construção de verificação

**Sintoma.** O `CLAUDE.md` passou a afirmar "Estação 6 (Prontidão) está
em curso" e "Estação 5 fechada, reaberta e fechada de novo". As duas
frases eram falsas: a 6 nunca tinha sido aberta, e a 5 nunca tinha
fechado. Nada quebrou — a porta de entrada do repositório é que passou a
mentir sobre onde o projeto está.

**Causa raiz.** Duas confusões, uma em cima da outra.

A primeira: **tratei lei como estação.** O pedido do dono foi um log de
auditoria do webhook. Como a Lei 8 é observabilidade e a Estação 6 é a
que verifica a Lei 8, classifiquei o trabalho como "entrega da Estação
6". Mas escrever código que uma lei um dia vai verificar é **construção**
— Estação 5 — e a skill `leis` diz isso explicitamente: *estação é etapa,
lei é verificação*, e a numeração das leis é catálogo de obrigações, não
ordem de execução.

A segunda, que é a grave: **dei uma estação por fechada com a entrega
dela só no disco.** O código novo não tinha sido commitado, o GitHub não
tinha recebido nada, a migration `0002` não tinha rodado no Supabase e o
Render não tinha recebido deploy. Construção que não subiu não é
construção fechada — e a Estação 6 verifica justamente **o que está no
ar**, então abri-la nesse estado faria a verificação inteira medir uma
estrutura diferente da que está em produção. Seria pior que não
verificar, porque sai com o carimbo de verificado.

**Correção.** `CLAUDE.md` reescrito: Estação 5 **aberta**, com as três
condições listadas e a primeira marcada como parcial pelo motivo certo;
Estação 6 **não iniciada**; o log de auditoria registrado como construção
da 5. A pendência bloqueante voltou para a lista, na ordem que resolve —
commit, push, migration no SQL Editor, deploy, e conferência ao vivo. No
`CONSTRAINTS.md`, duas frases que mandavam trabalho futuro "para a
Estação 6" passaram a apontar para `docs/proximas-versoes.md`, que é onde
mora o que ainda não se construiu.

**Guarda.** Antes de escrever que uma estação fechou, perguntar onde está
a entrega dela: **no disco não conta.** Para a Estação 5 especificamente,
a checagem é objetiva e barata — `git status` limpo, o commit no GitHub,
a migration rodada, o deploy feito, e a URL pública respondendo. Enquanto
qualquer um desses quatro estiver pendente, a estação está aberta, por
mais completo que o código pareça.

**Como evitar na origem.** Trabalho pedido no meio de uma estação é
trabalho **daquela** estação, não autorização para abrir a próxima — e a
pista de que a classificação escorregou é ter que citar uma lei para
justificar a mudança de estação. A ordem das estações não é burocracia:
cada uma entrega o que a próxima precisa, e a Prontidão precisa de algo
no ar para poder olhar. Quando a entrega depende de uma ação do dono
(commit, deploy, migration), a estação **pausa nessa pendência** — que é
a regra que a skill `leis` já dá, e que eu contornei ao seguir em frente
construindo mais.

**Ecossistema:** sim — não depende deste código nem desta stack. Vale
para qualquer projeto com etapas de verificação depois das de
construção, e a tentação é geral: código pronto **parece** entrega
pronta, e o passo que falta (subir) é sempre de outra pessoa, o que faz
ele sumir da vista de quem escreveu.
