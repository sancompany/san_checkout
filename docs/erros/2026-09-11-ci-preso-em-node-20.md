# CI falha porque fica preso em Node 20, e a dependência já exige 22+

## O que aconteceu

Ao conferir a Estação 3 (Fundação) — "CI verde num push real" — o último
push (`11498e5`, "atualização hash") está com o job `testes` em
**Failure**. 1 de 4 suítes falhou: `src/services/pedidoService.js`.

## Causa raiz

O log mostra o motivo direto:

```
Error: Node.js detected but native WebSocket not found.
Suggested solution: Ensure you are running Node.js 22+ or provide a
WebSocket implementation via the transport option.
    at .../@supabase/realtime-js/dist/main/RealtimeClient.js
```

`package.json` fixa `"@supabase/supabase-js": "^2.45.0"` (faixa aberta,
sem trava de versão exata) e a versão instalada hoje já exige WebSocket
nativo — presente a partir do Node 22. O `.github/workflows/ci.yml`
fixa `node-version: '20'`. A dependência avançou, o CI não.

**Por que a produção não caiu com o mesmo erro:** o Render nunca teve
`engines.node` declarado em `package.json`, então escolheu sozinho uma
versão de Node mais nova por padrão — que por sorte já tem WebSocket
nativo. O CI é que ficou preso porque `node-version: '20'` era uma
escolha explícita, não um padrão que acompanha o tempo.

## Correção

1. **Aditivo, aplicado agora**: `package.json` ganhou
   `"engines": { "node": ">=22" }` — declara a versão real que o projeto
   já precisa, em vez de depender de qual padrão cada plataforma escolhe
   hoje. Efeito colateral bom: o Render, que lê `engines` para escolher a
   versão, passa a fazer isso de propósito, não por acaso.
2. **Estrutural, `.github/workflows/` é protegido contra escrita
   remota** — entregue pronto para colar, registrado como pendência que
   bloqueia a esteira até o dono aplicar (ver `CLAUDE.md`): trocar
   `node-version: '20'` por `'22'` em `ci.yml`.

## Como não repetir

Faixa de versão aberta (`^2.45.0`) em dependência que outros ambientes
(CI, produção) fixam separadamente é o padrão exato deste erro: o pacote
anda, o ambiente fixo fica para trás em silêncio até quebrar. `engines`
no `package.json` é a trava que faz os três lugares (dev local, CI,
Render) andarem pela mesma régua.

## Fechado — 11/09/2026

`ci.yml` colado com `node-version: '22'` e commitado (`4c01cda`).
Reverificado ao vivo: run #5 (`atualização ci`) — **Status: Success**,
4 suítes passando, 15s de duração. O aviso restante no log
("Node.js 20 is deprecated... forced to run on Node.js 24") é sobre o
runtime que o próprio GitHub usa para executar as actions
(`checkout@v4`, `setup-node@v4`), não sobre o Node que roda os testes —
não é a mesma causa e não bloqueia nada.
