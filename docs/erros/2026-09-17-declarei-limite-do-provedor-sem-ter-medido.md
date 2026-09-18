# Declarei um limite do provedor sem ter medido, e uma decisão foi tomada em cima disso

**Quando:** escrito em 16/09/2026, derrubado em 17/09/2026 quando o dono
perguntou "não é possível fazer uma alteração de preço nos planos já
contratados?".
**Onde:** `API.md` §4.2, §5.3 e a tabela de "o que não existe";
`docs/proximas-versoes.md` ("Trocar de plano numa assinatura já ativa");
`CLAUDE.md`.

## O que eu afirmei

> "`valor` e `ciclo` são congelados na criação da assinatura, **e isso
> não é limitação nossa: é como a assinatura existe na Asaas**. Para
> mudar o preço de um assinante, cancele e crie uma assinatura nova."

Escrito em quatro lugares, incluindo o `API.md` — que é o contrato que
o integrador lê e obedece.

## O que a medição diz

Sandbox, dentro do contêiner (a chave nunca saiu), fixture descartável
apagada no fim:

| tentativa | resposta | `GET` de volta |
|---|---|---|
| `PUT {value: 35}` numa assinatura de R$ 20 | `200` | `value: 35` |
| `PUT {value: 42, updatePendingPayments: true}` | `200` | `value: 42`, **e a cobrança pendente já gerada foi de R$ 20 para R$ 42** — mesmo id, mesmo vencimento |
| `PUT {cycle: QUARTERLY}` num `MONTHLY` | `200` | `cycle: QUARTERLY` |
| **controle negativo:** `PUT {campoQueNaoExiste}` | `200`, sem erro | nada mudou |

A Asaas permite. O congelamento era **do nosso fluxo**, não do provedor.

## Por que o erro passou

Três coisas, e a terceira é a que dói:

1. **Eu inferi a partir do que o nosso código faz.** O checkout congela
   valor e ciclo na criação (e faz certo, por outro motivo: não
   reconsultar o plano a cada cobrança). Disso eu concluí que a Asaas
   impunha o congelamento — conclusão sobre um terceiro tirada de uma
   escolha nossa.
2. **A pergunta original era de produto, e eu respondi como se fosse de
   infraestrutura.** "O checkout atende trocar de plano?" tem resposta
   curta e verdadeira: "não existe rota nossa". Em vez disso eu
   acrescentei um *porquê* que eu não tinha medido, e o porquê é que
   virou mentira.
3. **A skill `construir` manda consultar a documentação oficial da
   versão instalada antes de decidir contra um terceiro** — e o gatilho
   estava cravado: "o serviço é de terceiro e o contrato é dele
   (Asaas…)". Eu não consultei. Pior: quando consultei, em 17/09, a
   primeira leitura da doc **também** me deu resposta errada — o
   resumidor listou o schema sem `value` e ainda assim afirmou que
   `value` era alterável. Só a medição resolveu.

## O custo, que é o ponto

**Uma decisão do dono foi tomada sobre a premissa falsa.** Em 16/09 ele
decidiu que o MostrAí resolveria troca de plano pela ideia do pedido
avulso — escolha razoável, e que pode continuar valendo. Mas ela foi
feita acreditando que a alternativa não existia. Decisão tomada com fato
errado não é decisão informada, mesmo quando o resultado por acaso é
bom.

Foi ele quem derrubou a afirmação, com uma pergunta de uma linha. É a
segunda vez em dois dias: em 16/09 ele me disse "o que não falta é você
ficar cego" quando eu declarei três coisas imensuráveis segurando as
ferramentas para medi-las.

## A regra que fica

**Nunca afirmar que um terceiro não permite algo sem ter tentado.** O
custo de tentar, aqui, foi um script de 100 linhas e uma fixture de
sandbox apagada em seguida. O custo de não tentar foi um contrato
público errado e uma decisão mal informada.

E a forma da frase importa: **"não existe rota nossa" e "o provedor não
permite" são afirmações diferentes**, com donos diferentes e custos
diferentes. A primeira eu sei sem medir — é o nosso código. A segunda
exige medição, sempre.

## A armadilha técnica que a medição revelou de brinde

**A Asaas responde `200` e ignora em silêncio campo que ela não
conhece.** O controle negativo (`campoQueNaoExiste`) voltou `200` sem
erro nenhum. Consequência para quem for construir a troca de preço:

- o status HTTP **não prova** que a alteração aconteceu — quem prova é o
  `GET` de volta;
- mandar `valor` (em português) ou `amount` em vez de `value` seria
  aceito com `200` e não mudaria nada, silenciosamente;
- e **`value` não está no schema documentado** do `PUT`. Funciona, é
  comportamento não documentado, e pode mudar sem aviso — então exige
  teste que fique vermelho no dia em que parar de funcionar.

**Ecossistema:** sim. "Provedor não permite" é a classe de afirmação que
mais se propaga sem prova, porque ninguém checa o óbvio.
