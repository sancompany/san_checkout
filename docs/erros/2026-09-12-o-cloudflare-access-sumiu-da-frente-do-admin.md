# O Cloudflare Access sumiu da frente do admin

**Quando:** 12/09/2026
**Onde:** `checkout.sancocore.com.br/admin.html` e `/admin`
**Quem achou:** o operador, ao reparar que o painel não pedia mais o
e-mail antes do usuário e senha.

## O que aconteceu

A camada 1 da proteção do painel (`CONSTRAINTS.md` §2.6) — o aplicativo
"Painel admin do San Checkout" no Cloudflare Zero Trust, configurado e
verificado em 11/09 — **deixou de interceptar**. Quem abre a URL recebe
o painel direto, sem provar quem é.

Sobrou só a camada 2, usuário e senha no backend. O painel não ficou
aberto para qualquer um, mas ficou com **uma** barreira onde o desenho
pede duas, e a que caiu é justamente a que impede alguém sem credencial
nenhuma de sequer ver a tela.

## Como foi confirmado, e por que o jeito importa

Requisição **de fora, sem cookie nenhum**, a partir de um ambiente que
nunca passou pelo Access: as duas grafias (`/admin.html` e `/admin`)
responderam com o HTML do painel — título "San Checkout — Admin",
formulário de usuário e senha. `/index.html` continua público, que é o
outro lado do teste (caminho mal escopado colocaria o Access na frente
do checkout inteiro).

O operador não conseguiria distinguir isso do navegador dele: o cookie
do Access dura horas, e sessão válida não pede login. **É exatamente a
lição já registrada no §2.6 em 11/09** — "testar controle de acesso de
dentro da sessão autenticada não testa nada" — e desta vez ela apareceu
ao contrário: não foi um teste que passou falso, foi o operador
percebendo pela AUSÊNCIA da tela e desconfiando. Desconfiar foi certo.

## Causa

Não determinada daqui. O que dá para afirmar: não é cache nem
propagação (a resposta veio de origem, com o corpo do painel), e não é o
caminho errado na política (as duas grafias responderam igual — se fosse
escopo, uma passaria e a outra não).

O que resta olhar no painel do Zero Trust, nesta ordem:

1. O aplicativo "Painel admin do San Checkout" ainda existe? Aplicativo
   apagado não deixa rastro na zona.
2. Os **quatro destinos** continuam lá — `/admin.html` e `/admin`, em
   `checkout.sancocore.com.br` **e** em `san-checkout.pages.dev`?
3. A política "Somente o operador" continua ligada ao aplicativo, com
   ação Permitir?
4. O domínio do Pages mudou de nome ou de projeto? Destino que aponta
   para um hostname que não existe mais não intercepta nada, e não
   reclama.

A suspeita mais provável é a reorganização de DNS de 12/09, quando
`api.sancocore.com.br` foi criado para o Northflank — mexer na zona é
quando aplicativo de Access some sem ninguém reparar.

## O que fica

- **Configuração de painel só o dono aplica.** Recriar o aplicativo é
  ação dele no Zero Trust, não daqui.
- **Verificação de controle de acesso passa a ser sempre de fora e
  sempre nas duas grafias**, como o §2.6 já mandava — e agora também
  **depois de toda mexida na zona de DNS**, que é o gatilho que faltava
  na lista.
- Bloqueia a Estação 6: prontidão com uma camada a menos do que o
  documento declara não é prontidão, é o documento mentindo.
