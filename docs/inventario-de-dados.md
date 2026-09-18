# Inventário de dados pessoais — San Checkout

Atualizado em 11/09/2026.

Regra de manutenção: **campo novo sem linha nova é tarefa incompleta.**
Este arquivo é a fonte dos Termos de Uso e da Política de Privacidade
(ver skill `legal`).

---

## 1. Comprador (titular terceiro — não é o operador)

Coletado na tela de pagamento, gravado na tabela `cobrancas`.

| Dado | Coluna | Para quê | Quem mais recebe |
|---|---|---|---|
| Nome ou razão social | — (só trafega) | Identificar o pagador na Asaas | Asaas |
| CPF ou CNPJ | `documento` | Exigência da Asaas para criar cobrança; conciliação | Asaas |
| E-mail | `email` | Identificar o cliente na Asaas; conciliação | Asaas |
| Telefone | `telefone` | Exigência da Asaas para Cartão/Assinatura | Asaas |
| Endereço: logradouro, número, complemento, bairro, CEP, cidade, UF, código IBGE | `endereco`, `endereco_numero`, `endereco_complemento`, `bairro`, `cep`, `cidade`, `uf`, `cidade_ibge` | Antifraude da Asaas — **só em Cartão e Assinatura por cartão**; Pix, boleto e Pix Automático não pedem | Asaas |
| Itens do pedido | `itens` | Exibição no resumo e conciliação | — |
| Valores, taxas, método, status | vários | Registro financeiro | Contratante (via webhook) |

**Não coletado, nunca:** número de cartão, CVV, validade, titular do
cartão. Esses dados são digitados numa pop-up hospedada pela Asaas e não
passam por este servidor nem pelo servidor do contratante.

**Origem alternativa:** o contratante pode pré-preencher nome, e-mail,
documento e telefone no `pagador` do `GET /pedido/{id}` — nesse caso o
dado vem dele, não do comprador digitando.

## 2. Assinante

Tabela `assinaturas`: `documento` (CPF/CNPJ), mais valor, ciclo e próxima
cobrança. É o par `plano_id` + `documento` que identifica o assinante nas
operações de cancelar, pausar, retomar e conciliar.

## 3. Titular de subconta Asaas

Tabela `subcontas`, preenchida pelo operador no painel administrativo ao
abrir uma subconta: `nome`, `email`, `documento`, `telefone`, `celular`,
`endereco`, `endereco_numero`, `complemento`, `bairro`, `cep`,
`faturamento`, `tipo_empresa`, `data_nascimento`. Enviados à Asaas em
`POST /v3/accounts`.

Guarda também `wallet_id`, `api_key` e `link_ativacao` da subconta —
credenciais, não dado pessoal, mas com o mesmo cuidado de exposição
(mascaradas na tela, reveladas só sob clique).

## 4. Operador

`CHECKOUT_ADMIN_USER` e `CHECKOUT_ADMIN_PASS_HASH` em variável de
ambiente do Render. Não há tabela de usuários, não há senha no banco e a
senha em texto puro não é guardada em lugar nenhum — o que fica no Render
é o hash scrypt (N=2^17), envelopado em base64.

### 4.1 O CPF do operador é PUBLICADO, e é obrigação legal

Desde 17/09/2026 os Termos e a Política identificam o operador como
**pessoa física**: nome civil, **CPF** e endereço, em página pública.

| dado | onde | por quê |
|---|---|---|
| nome civil | `public/termos.html` §1.1, `public/privacidade.html` (contatos e rodapé) | Decreto 7.962/2013, art. 2º: o fornecedor identifica-se com nome e inscrição **no CPF ou no CNPJ** |
| CPF | idem | operando como pessoa física, o CPF **é** a inscrição exigida |
| endereço físico | idem | mesmo artigo: endereço físico e eletrônico em destaque |

**A exposição é consciente, não descuido.** CPF em página pública é
identificador de alto valor no Brasil e fica sujeito a coleta
automatizada. Não há alternativa legal enquanto a operação for de pessoa
física: omitir a inscrição descumpre o Decreto, e publicar parcialmente
não identifica. **A saída é a transição para CNPJ** — que os próprios
documentos anunciam, e que está em `docs/proximas-versoes.md` com
gatilho. Quando concluída, o CPF sai daqui.

Este é o único dado pessoal **do operador** que o projeto publica. Nada
de titular de terceiro é publicado em lugar nenhum.

---

## 5. Onde os dados ficam

| Onde | O quê | Observação |
|---|---|---|
| Supabase (Postgres) | Tudo das seções 1-3 | RLS habilitado nas seis tabelas (as quatro de negócio mais as duas de auditoria da seção 7.1); só o backend acessa, com `service_role`. Região `sa-east-1` — **Brasil** |
| Asaas | Cliente, cobrança, assinatura, subconta | Operador de pagamento; sub-processador. Provedor brasileiro |
| Northflank | Logs da aplicação | Ver seção 7. Região `southamerica-east` — **Brasil**, medido pela API do provedor em 17/09/2026. **Esta linha dizia "Render" até 17/09/2026**, e o Render deixou de ser usado em 12/09: inventário que nomeia o fornecedor errado aponta a transferência internacional errada, que é o pior lugar para estar desatualizado |
| Cloudflare Pages | Nada em repouso — front estático | Não recebe dado pessoal em repouso. Mas trata **dado técnico de conexão em trânsito** (IP, agente do navegador, metadados), porque é ela que entrega a página |
| Cloudflare Web Analytics | Métrica de desempenho da página, agregada | **Ativo desde 01/09/2026**, e descoberto em 17/09 só porque a CSP o liberava: a Cloudflare injeta o beacon sozinha (`auto_install`) nas páginas que ela serve, então ele **não aparece no HTML do repositório**. Coleta o mínimo para tempos de carregamento; **sem cookie** e sem perfil, e a Cloudflare declara não rastrear usuário final entre sites de clientes. Base legal: legítimo interesse. Guarda: definida pela Cloudflare — a documentação pública consultada não declara prazo, e não inventamos um. Declarado na política, §15.5 a 15.9 |
| Cloudflare Access | Identidade do operador no login administrativo | Camada de borda do `/admin`; trata o e-mail do operador para autorizar |
| Contratante | Payload do webhook e da conciliação | Não inclui endereço; inclui `pedidoId`, valores e, em assinatura, `documento` |
| Contratante (navegação de volta) | Só o `pedidoId`, na URL de retorno | Desde 15/09/2026. O `returnUrl` leva o comprador de volta à loja depois de pagar e carrega **um** parâmetro, `pedido` — um id que o próprio contratante gerou e já conhece. Nenhum dado pessoal, e nenhum status de pagamento, viaja por aí (`API.md` §3.1). O destino é sempre origem do próprio contratante, conferida no servidor |

## 6. Retenção e exclusão

**Prazo decidido em 11/09/2026: 5 anos contados da transação.** Escolhido
por alinhar-se ao prazo de reclamação do CDC (art. 27) e à guarda fiscal
usual. Depois desse prazo o dado é expurgado.

Exclusão antes do prazo, a pedido do titular (LGPD art. 18), é atendida
caso a caso — respeitada a guarda legal do que não pode ser apagado
enquanto o prazo fiscal correr.

> ✅ **A ROTINA EXISTE DESDE 17/09/2026.** Era a primeira das duas
> pendências desta seção, e a frase que estava aqui era: *"o prazo está
> decidido, mas nada apaga nada hoje — enquanto não houver a rotina, o
> prazo é intenção, não prática."*
>
> `src/services/expurgoService.js`, ligada ao ciclo de 24 h do
> `server.js` junto dos outros dois expurgos, e com porta de mão para o
> operador em `npm run expurgo` (simula por padrão). Duas funções,
> porque são duas coisas diferentes: o **prazo** (cinco anos, tudo que
> passou) e o **pedido do titular** (LGPD art. 18, antes do prazo).
>
> **Anonimiza, não apaga** — é o que §6.2 abaixo verificou ser possível
> na modelagem. E decide por **lista branca do que FICA**, não por lista
> de o que sai: lista negra falha aberta, e falhar aberta aqui é uma
> coluna pessoal criada em 2027 sobrevivendo para sempre porque alguém
> esqueceu de atualizar um arquivo. O autoteste (46 checagens) confere a
> lista contra as colunas reais do banco, então coluna nova deixa a
> suíte vermelha até alguém decidir de que lado ela fica.
>
> Conferida contra o banco de produção no mesmo dia, em simulação, de
> dentro do contêiner: o filtro alcança as 10 cobranças e as 3
> assinaturas que existem (controle positivo com o corte em "agora"), e
> com o corte real — 2021-09-17 — não alcança nenhuma, porque não existe
> transação de cinco anos atrás. Ela não faz nada até 2031; o valor de
> estar ligada agora é não depender de alguém lembrar em 2031.
>
> ⚠️ **A SEGUNDA PENDÊNCIA CONTINUA ABERTA: validação jurídica.** Os 5
> anos são a escolha mais defensável sem advogado, não um parecer. A
> skill `legal` fecha isso na Estação 7, antes do lançamento — e é de lá
> que sai o texto da Política de Privacidade. Se o parecer mudar o
> prazo, muda a constante `ANOS_DE_RETENCAO`, e nada mais.
>
> Vale também para a Asaas: o dado que foi enviado a ela segue a
> retenção **dela**, não a nossa.

## 6.1 Dado pessoal dentro do próprio repositório

> ⚠️ **PENDÊNCIA ABERTA — confirmada no histórico, não só suspeita.** A
> pasta `Claude outputs/` contém capturas de tela do painel
> administrativo com **dado pessoal legível**: nome, e-mail, telefone,
> endereço completo, data de nascimento e faturamento declarado, de
> pessoa física e de empresa.
>
> As credenciais nessas imagens estão mascaradas (conferido em
> 11/09/2026) — a máscara protege o segredo, não a pessoa.
>
> **RESOLVIDO EM 11/09/2026.** Durante a Estação 4 confirmou-se que a
> pasta havia sido commitada: três commits tocavam o caminho
> (`b24a47f`, `d4b31c4`, `cadc248` — identificadores de antes da
> reescrita, que já não existem). Sair do `HEAD` e entrar no
> `.gitignore` impedia daqui para frente, mas não alcançava o que já
> tinha subido — e nenhuma rotina de exclusão chega ao histórico do git.
>
> O dono reescreveu o histórico com `git filter-repo --path
> "Claude outputs" --invert-paths` e forçou o push. **Reverificado no
> GitHub:** o histórico do caminho `Claude outputs` responde *"No commits
> history"*, e todos os SHAs mudaram (o topo do `main` passou de
> `4c01cda` para `1fc7038`), o que confirma a reescrita.
>
> Ressalva registrada: o GitHub mantém objetos órfãos alcançáveis por SHA
> direto até a coleta de lixo dele; para garantia total seria preciso
> pedir o `gc` ao suporte. O repositório é privado, com um único
> contribuidor, e nunca houve exposição a terceiro.
>
> Os arquivos continuam no disco local, fora do versionamento — é onde
> devem ficar.

## 6.2 O caminho de exclusão existe na modelagem (verificado na Estação 4)

A skill `legal` trata isto como decisão de arquitetura, não de texto: se
o modelo não permitir apagar sem quebrar histórico ou guarda fiscal, o
problema é de modelagem. Conferido contra o schema — que hoje são as
**migrations numeradas** em `supabase/migrations/` (a `0001_baseline.sql`
tem os `create table`), e não mais um arquivo de schema único — ele
deixou de existir quando a regra de migrations imutáveis entrou
(`CONSTRAINTS.md` §2.1). Este parágrafo apontava para o arquivo antigo
até 18/09/2026:

- Em `cobrancas`, o dado pessoal (`documento`, `email`, `telefone`, os
  oito campos de endereço, `itens`) está em colunas **separadas** do
  registro financeiro (`charge_id`, valores, taxas, `metodo_pagamento`,
  `status`, datas). Anonimizar é anular as primeiras e manter as
  segundas — a linha continua servindo de registro fiscal e de
  conciliação sem identificar ninguém.
- Em `assinaturas`, `documento` faz parte da chave de busca
  (`contratante_id` + `plano_id` + `documento`). Anonimizar quebra a
  busca, mas só faz sentido anonimizar assinatura **cancelada**, que já
  não é buscada.
- `subcontas` é dado do operador/parceiro, não do comprador, e tem
  guarda própria enquanto a subconta existir na Asaas.

Ou seja: o que faltava era a **rotina**, não a possibilidade — e ela foi
escrita em 17/09/2026 exatamente sobre esta leitura da modelagem. A
modelagem não precisou mudar para atender a LGPD art. 18.

**Uma consequência que só aparece na hora de executar:** assinatura
**viva** (ativa ou pausada) não é anonimizada nem a pedido do titular,
porque o `documento` é a chave com que ele cancela a própria assinatura
(`API.md` §5.5). Apagar o documento tiraria dele a capacidade de
cancelar — o oposto do que o pedido quer. E cancelar por conta própria
seria decidir por outra pessoa algo com consequência financeira. Então a
rotina **relata** as assinaturas vivas em vez de agir: o titular cancela,
e o expurgo alcança na rodada seguinte.

## 7. Log

**Corrigido em 11/09/2026.** Até então o backend imprimia o payload
**cru** dos webhooks da Asaas, que contém nome, e-mail, CPF/CNPJ,
telefone e endereço do comprador (nunca dado de cartão), retido pelo
Render — era a pendência aberta desta seção.

Hoje o `webhookController.js` imprime e grava a versão **redigida**
(`redigirPayload`, em `src/services/auditoriaWebhookService.js`): passa
por lista branca de nome de campo, e o que não está nela vira só o
**caminho da chave**, sem valor nenhum. O autoteste do serviço prova
isso com um payload realista — se um CPF, nome, e-mail, telefone,
endereço ou id de cliente sobreviver à redação, a suíte falha.

A troca não custou diagnóstico: a pergunta que mantinha o log cru vivo
("no `CHECKOUT_PAID` real, o id vem em `checkout.payment.id` ou em
`payment.id`?") é sobre formato, e o mapa de caminhos responde sem
carregar dado de pessoa.

## 7.1 Tabelas do log de auditoria do webhook

Criadas pela migration `0002_webhook_auditoria.sql`.

| Tabela | Dado pessoal | Retenção |
|---|---|---|
| `webhook_eventos` | **Nenhum** — só nome de evento, id da cobrança na Asaas, resultado e os campos redigidos | 90 dias, apagados pela rotina `expurgarAuditoria` (roda no boot e a cada 24h, `server.js`) |
| `webhook_rejeicoes` | **Endereço IP** de quem tentou usar o endereço do webhook sem o token, dentro de `amostras` | As amostras (onde o IP mora) são esvaziadas depois de **30 dias**. A linha de contagem por hora fica, e não tem dado de pessoa nenhum |

O IP entra por ser registro de segurança — é o que separa uma sondagem
automática de um erro de configuração do lado da Asaas. O **token
recusado nunca é gravado**: além de ser credencial em texto puro, quem
errasse uma letra do token certo gravaria o token certo no banco.

Estas tabelas são diagnóstico, **não herdam os 5 anos da seção 6** — e
a rotina que as expurga é a primeira rotina de expurgo que este projeto
tem de fato. A da seção 6, sobre o dado do comprador, continua
pendente.

## 7.2 Tabela da captura de exceção

Criada pela migration `0007_captura_de_erro.sql`, em 16/09/2026.

| Tabela | Dado pessoal | Retenção |
|---|---|---|
| `erros` | **Nenhum, por construção** — contexto, padrão da rota, método, status, tipo e código do erro, quadros de pilha do nosso `src/`, e a mensagem **raspada** | 30 dias, pela rotina `expurgarErros` (boot e a cada 24h, `server.js`) |

**O que nunca entra:** corpo da requisição, query string, cabeçalho, IP,
e a URL real. `rota` guarda o **padrão** do Express
(`/api/checkout/status/:contratanteId/:pedidoId`), nunca a URL chamada —
a URL carrega o `pedidoId`, que por desenho é imprevisível
(`exigirIdImprevisivel`) e portanto é credencial, não identificador.

**A mensagem é o único texto livre, e é raspada antes de gravar.** Lista
branca não se aplica a texto livre, e a §2.5 proíbe lista negra porque
lista negra falha aberta. A saída foi inverter a pergunta: em vez de
enumerar o que remover, enumerar **o que sobrevive** — letras, pontuação
e números curtos. Toda corrida de 4+ dígitos sai, em qualquer formatação;
e-mail, token longo e query string também. É o que mata CPF, CNPJ,
telefone, CEP e cartão sem depender de acertar o formato, porque o que
identifica pessoa é número e o que se depura é palavra.

O autoteste de `erroService.js` prova isso: se um CPF (em quatro
formatações), e-mail, telefone, CEP ou chave sobreviver, a suíte falha.
Verificado por sabotagem em 16/09.

Diagnóstico como as de 7.1 — **não herda os 5 anos da seção 6**, e tem
retenção ainda mais curta que os 90 dias do webhook.
