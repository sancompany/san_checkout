# O diagnóstico de subconta lia o endpoint errado, e mandou investigar o lado errado

**17/09/2026 · `adminController.explicarRecusaDeSubconta`, `asaasService.tipoDaContaMae`**

## O sintoma

Criar subconta devolvia `403` da Asaas:

> Contas de pessoa física (CPF) não podem criar subcontas no Asaas.
> Apenas contas de pessoa jurídica (CNPJ) podem acessar essa
> funcionalidade.

E a nossa explicação, colada na resposta, dizia o **contrário**:

> a conta-mãe é pessoa jurídica (LIMITED), então o problema NÃO é o tipo
> de conta — restam permissão de subcontas não liberada nesta conta ou
> CNAE incompatível. Isso se resolve com o suporte da Asaas.

O dono leu isso, conferiu que a conta estava como PJ, viu o 403
continuar, e concluiu — corretamente — que o erro estava no nosso
código. Estava: na mensagem, não na chamada.

## A causa

**A Asaas guarda duas identidades separadas na mesma conta, e elas podem
discordar.** Medido:

| endpoint | `personType` | documento | nome |
|---|---|---|---|
| `/v3/myAccount` — o **registro** | `FISICA` | CPF, 11 dígitos | pessoa |
| `/v3/myAccount/commercialInfo` — o **comercial** | `JURIDICA` | CNPJ, 14 dígitos | empresa |

`/v3/myAccount/status` dizia `commercialInfo: APPROVED`,
`general: APPROVED`, `documentation: APPROVED` — tudo aprovado. A conta
parece PJ em todo lugar do painel.

**A regra de subconta olha o registro.** `tipoDaContaMae()` lia só o
`commercialInfo`, via `JURIDICA`, e a explicação concluía que o tipo de
conta não era o problema. Era exatamente ele.

**Preencher o CNPJ da empresa nas informações comerciais não converte a
conta em pessoa jurídica.** É a confusão mais provável de quem "já mudou
para PJ" e continua levando 403 — e era a nossa mensagem que a
sustentava.

## O que o controle positivo mostrou, e sem ele eu teria errado de novo

A primeira leitura do 403 foi: "a Asaas culpa o tipo da conta-mãe, mas a
conta é PJ — então a mensagem dela está errada". Daí saiu uma conclusão
errada minha, dita ao dono: *que subconta com CPF é suportada e a
restrição era só da conta-mãe*.

O que derrubou isso foi repetir a criação **com CNPJ**, como controle:

| tentativa | resultado |
|---|---|
| subconta com **CPF** | `403`, mensagem acima |
| subconta com **CNPJ** | `403`, **mensagem idêntica** |

Os dois recusados igual. Logo o 403 não fala do documento da subconta —
fala da conta que está criando. A mensagem da Asaas estava certa desde o
início; quem estava errado era o nosso diagnóstico, e depois eu.

E a afirmação que eu tinha feito — "subconta pode ser CPF" — nunca foi
testada: a criação é barrada antes de o documento da subconta importar.
Eu a deduzi de o nosso código ter um ramo `birthDate` para pessoa
física, que prova apenas que **sabemos enviar** esse payload, não que a
Asaas o aceita. Deduzir capacidade do provedor a partir de código nosso
é o mesmo erro de ler contrato na paráfrase em vez de na fonte.

## A correção

`tipoDaContaMae()` passa a ler **os dois** endpoints: `/v3/myAccount`
decide o tipo, `commercialInfo` entra como complemento, e um campo
`divergem` marca o caso em que a conta é PF com comercial PJ. A
explicação usa isso para dizer, nesse caso específico, que o painel
parece PJ e a regra olha o registro.

A mensagem também passa a dizer que **trocar o documento da subconta não
resolve**, com o número medido — para ninguém gastar uma tarde tentando
variações, como quase aconteceu aqui.

## A lição

**Dois endpoints do mesmo provedor sobre o mesmo objeto podem discordar,
e escolher o mais conveniente é escolher a resposta errada.** Quando uma
mensagem de erro do provedor contradiz o que o nosso código acha, a
hipótese default tem de ser que o provedor sabe mais sobre a conta dele
do que nós — não o inverso.

E a que já é regra aqui e voltou a se provar: **controle positivo não é
zelo, é o que separa medição de impressão.** Sem a tentativa com CNPJ,
eu teria fechado com a conclusão errada — pela segunda vez no mesmo
assunto, no mesmo dia. É a mesma lição do ataque ao `returnUrl` em
15/09, quando a primeira rodada deu "recusou" em tudo porque a chave
estava falsa.
