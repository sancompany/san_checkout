# Total ausente aparecia como "R$ NaN", e "consertar para zero" era pior

**Sintoma.** No resumo do checkout, `subtotal`, `desconto` e
`taxasTotais` eram lidos com `Number(x ?? 0)`; só o total não
(`const total = taxa.valorCobrado;`). Faltando esse campo na resposta, a
tela mostrava **"Total R$ NaN"** — com o formulário e o botão de pagar
inteiros ao lado.

**Causa raiz.** Três das quatro linhas de dinheiro foram defendidas e a
quarta não. Não era alcançável na prática (o backend sempre manda o
campo), mas era a única sem guarda, e o custo de errar ali é o mais alto
da tela.

**Correção.** A correção óbvia — igualar as quatro com
`Number(taxa?.valorCobrado ?? 0)` — é a **errada**, e quase entrou: ela
troca "R$ NaN" por "R$ 0,00", que é pior. NaN é visivelmente quebrado e
ninguém confirma uma compra assim; "R$ 0,00" parece compra grátis, o
comprador confirma, e o valor cobrado não é o da tela — vem do modelo
pull no servidor. A tela mentiria e o cartão seria debitado com outro
número. **Valor desconhecido não é valor zero: zero é um preço, ausência
não é.**

O que entrou foi falhar o carregamento, que é o que gateway nenhum faz
diferente — sessão sem total não vira checkout. `aplicarNoResumo` lança
quando `valorCobrado` não é finito ou é `<= 0`, e o `catch` de
`resolverContexto` chama `marcarPedidoIndisponivel`, que escreve o erro,
troca os valores por travessão e **esconde o painel de pagamento**.

**Guarda.** A verificação é com a tela renderizada, e foi ela que pegou a
correção incompleta: a primeira versão parava no `throw` e no erro do
título, o que parecia suficiente **lendo o código**. Renderizada, a tela
mostrava "Total **R$ 0,00**" e o botão "Gerar QR Code Pix" ativo — porque
o `0,00` é o **placeholder do HTML**, e lançar antes de preencher
simplesmente o deixa lá. A correção contra o "parece compra grátis"
tinha produzido exatamente "parece compra grátis".

**Como evitar na origem.** Ao defender um valor exibido, defender
**todos** os irmãos na mesma passada — três de quatro protegidos é sinal
de que a quarta foi esquecida, não de que é segura. Ausência de valor
nunca vira zero numa tela de dinheiro: ou o dado aparece, ou a tela
deixa de oferecer a ação. E estado de erro precisa **apagar o
placeholder**: marcação que começa com `0,00` ou `--` no HTML vira dado
falso no instante em que o carregamento falha — o que sobra na tela
quando o preenchimento não acontece é invisível na leitura do código.

**Ecossistema:** sim — vale para qualquer tela que exiba valor vindo de
API, em qualquer stack. O par "ausência virou zero" + "placeholder
sobrevivendo ao erro" não depende de nada deste código.
