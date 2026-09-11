# CONSTRAINTS — San Checkout

O que este projeto **não** faz, e os limites que ele assume.

Se a pergunta é "posso construir isso aqui?", a resposta está neste
arquivo. Um item vetado só sai daqui por decisão explícita do dono do
projeto — não por alguém (pessoa ou IA) achar que seria uma boa ideia.

---

## 1. Escopo negativo — funcionalidade deliberadamente fora

### 1.1 Upsell one-click pós-compra — VETADO
Exige guardar o cartão tokenizado. Hoje o cartão é digitado numa pop-up
hospedada pela Asaas e **nunca toca este servidor** — é isso que mantém o
projeto fora do escopo PCI-DSS. Trazer cartão para dentro troca um ganho
incerto por auditoria de segurança, custo recorrente e responsabilidade
legal. `creditCardToken` não resolve: tokenizar também exige receber o
cartão cru antes.

### 1.2 Trocar o cartão de uma assinatura pela API — VETADO
Mesma razão. `PUT /v3/subscriptions/{id}/creditCard` exige `creditCard`
(número e CVV) e `remoteIp` como obrigatórios. O caminho aprovado é a
**renovação** pela pop-up (`&renovar=1`), que cria uma assinatura nova e
cancela a antiga só depois que a nova confirma.

### 1.3 Prova social sintética — VETADO
"237 pessoas compraram hoje" e similares. Não há fonte séria de ganho de
conversão *na etapa de checkout* — a decisão social acontece na página de
produto — e o projeto não tem o dado real para gerar isso com honestidade,
o que empurra para número inventado.

### 1.4 Timer de escassez falso — VETADO
Risco de publicidade enganosa (CDC art. 37). O checkout **já tem**
expiração real: o campo `expiraEm` que o contratante manda. Mostrar o
tempo real restante é legítimo; inventar prazo não é.

### 1.5 Multimoeda e internacionalização — FORA DE ESCOPO
Asaas é BRL, contratantes são BR, métodos são Pix, boleto e cartão
nacional. É resolver problema que o projeto não tem. Não existe parâmetro
de moeda em lugar nenhum, e isso é intencional.

### 1.6 Cashback, desconto progressivo e order bump com catálogo próprio — VETADO
Regra de preço pertence ao contratante. A arquitetura acertou ao manter
cupom e desconto vindo da API dele. Se um dia houver order bump, o
parceiro devolve as ofertas no próprio `GET /pedido/{id}` — o checkout
nunca guarda produto.

### 1.7 Estorno parcial — FORA DE ESCOPO
Sempre tudo ou nada. Para cancelar parte de um pedido, estorna-se tudo e
cria-se um pedido novo com o que sobrou.

### 1.8 Sandbox para o parceiro — FECHADO EM 11/09/2026
Exigiria dois clientes Asaas vivos no mesmo processo e roteamento por
requisição — mudança estrutural, não recurso. Hoje há um único parceiro,
que é o próprio operador. Reabrir quando existir parceiro externo de
verdade; a saída barata, nesse dia, é subir uma segunda instância do
backend apontando para o sandbox da Asaas, com Supabase próprio.

### 1.9 Nota fiscal e e-mail ao comprador — FORA DE ESCOPO (removidos em 08/09/2026)
Cada contratante emite a própria nota e manda o próprio e-mail,
disparados pelo evento que já chega no `webhook_url` dele. O checkout
processa pagamento e avisa; não emite documento fiscal nem fala com o
comprador em nome de ninguém.

### 1.10 Exclusão física de contratante — VETADO na forma óbvia
`cobrancas.contratante_id` é `on delete set null`: apagar um contratante
deixaria o histórico financeiro dele órfão. O caminho, quando for
construído, é **arquivar** (contratante some da lista e para de resolver
pedido, histórico permanece). Exclusão física só para contratante sem
nenhuma cobrança.

---

## 2. Limites assumidos (Lei 7)

- **Volume**: dimensionado para os projetos próprios do ecossistema
  (Trimundi9, Vitrina ADS e sucessores), não para ser gateway de mercado
  aberto. Não há evidência de necessidade de fila, cache distribuído ou
  réplica — e nenhum dos três existe, de propósito.
- **Moeda**: BRL, único.
- **Valor por cobrança**: R$ 0,01 a R$ 100.000,00 (`valorValido`).
- **Parcelamento**: 1 a 12 vezes.
- **Gargalos conhecidos, em ordem de probabilidade**:
  1. **Plano gratuito do Render** — hiberna por inatividade. Mitigado com
     ping externo (cron-job.org) em `/api/saude` a cada 10 minutos, que
     de quebra mantém o Supabase ativo. **Quando o tráfego real começar,
     o plano pago é a ação** — está decidido, só não contratado.
  2. **Fila de reenvio de webhook em memória** — 3 tentativas
     (1min/5min/15min) via `setTimeout`. Reinício do processo perde a
     notificação pendente. A rede de segurança é a conciliação
     (`API.md` 5.2 para pedido, 5.3 para assinatura). Virar fila
     persistente só com evidência real de perda.
  3. **Chave de API da Asaas expira por inatividade** — os eventos
     `ACCESS_TOKEN_*` viram alerta em `/api/saude`.
  4. **Cota gratuita do Supabase** — projeto pausa com 7 dias sem
     consulta; o mesmo ping resolve.

---

## 3. Exceções de conformidade registradas

Nenhuma até agora. Exceção aceita entra aqui com a lei, o motivo e a
data — exceção esquecida não é conformidade.
