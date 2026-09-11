# San Checkout — Integração

> **Este arquivo foi substituído por [`API.md`](./API.md).**
>
> A documentação de integração virou uma referência de API completa:
> todas as rotas, todos os campos, todos os códigos de erro, os limites
> do sistema e os exemplos de verificação de webhook em três linguagens.
>
> Comece por lá. Este arquivo continua existindo só para que os
> comentários no código-fonte que citam "INTEGRACAO.md seção X" ainda
> levem a algum lugar.

## Onde foi parar cada seção

| Antes (`INTEGRACAO.md`) | Agora (`API.md`) |
|---|---|
| 1 — Modelo pull | 1 — Como funciona |
| 2 — Formato do link | 3 — Links de checkout |
| 3 / 3.1 — Endpoint de pedido | 4.1 — `GET /pedido/{pedidoId}` |
| 3.1.1 — Sobre `status` | 4.1.1 — O campo `status` |
| 3.2 — Respostas de erro | 4.1.3 — Erros do seu endpoint |
| 4 / 4.1 — Webhook | 4.3 / 4.3.1 — Receber as notificações |
| 4.2 — Payload | 4.3.3 — Payload de pedido avulso |
| 4.3 — Novas tentativas | 4.3.6 — Política de novas tentativas |
| 4.4 — Consulta própria | 5.2 — Consultar uma cobrança |
| 4.5 — Página de status | 5.6 — Página pública de status |
| 4.6 — Compatibilidade | 10 — Compatibilidade e versionamento |
| 5 — Moeda | 5.1 — Convenções gerais |
| 6 — Combinado manualmente | 2 — Antes de começar |
| 6.1 — Assinatura | 4.2 (plano), 7 (detalhes), 5.5 (cancelar/pausar) |
| 6.2 — Pix Automático | 7.2 — Assinatura por Pix Automático |
| 7 — Estorno | 5.4 — Estornar |
| 8 — Taxas e split | 8 — Taxas, split e o valor cobrado |
| 9 — Checklist | 11 — Checklist de integração |

Novidades que não existiam no arquivo antigo: limites e validações do
sistema (seção 9), métodos de pagamento lado a lado (6), ciclo de vida
da assinatura (7.4), quando o webhook **não** chega (4.3.5), limites de
requisição e códigos de erro padronizados (5.1), a conciliação de
assinatura (5.3, rota nova) e a referência rápida de todas as rotas (12).
