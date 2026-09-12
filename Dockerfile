# =====================================================================
# SAN CHECKOUT — imagem de produção.
#
# POR QUE DOCKERFILE E NÃO BUILDPACK
# O `engines` do package.json diz `>=22`, que é FAIXA, não versão. O
# buildpack resolve essa faixa no dia do build e entrega a mais nova que
# achar — então dois deploys do mesmo commit podem rodar em Node
# diferentes, e a mudança chega sem ninguém pedir. Este projeto já foi
# mordido por versão de Node decidida em outro lugar:
# `docs/erros/2026-09-11-ci-preso-em-node-20.md`.
#
# Aqui a versão é escolhida uma vez, por escrito, e muda quando alguém
# decidir mudar.
# =====================================================================

# `alpine` porque imagem menor é menos coisa instalada, e menos coisa
# instalada é menos superfície para corrigir depois. O major fica
# pregado; o patch acompanha, que é o lado certo desse equilíbrio.
FROM node:22-alpine

# Encaminhamento de sinal. Sem isto o Node vira PID 1 e ignora SIGTERM:
# na hora de trocar a versão, a plataforma pede para encerrar, ninguém
# atende, e o processo é morto à força depois do prazo — no meio de uma
# cobrança, se houver uma em voo.
RUN apk add --no-cache tini

WORKDIR /app

# As dependências entram ANTES do resto do código de propósito: enquanto
# o `package-lock.json` não mudar, esta camada é reaproveitada e o build
# não reinstala nada. É o que faz o deploy de uma linha alterada levar
# segundos em vez de minutos.
COPY package.json package-lock.json ./

# `npm ci` e não `npm install`: o `ci` obedece ao lock ao pé da letra e
# falha se os dois discordarem. `install` "conserta" a divergência
# sozinho — e num caminho de dinheiro, dependência trocada em silêncio é
# exatamente o que não pode acontecer.
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# O usuário `node` já vem na imagem. Rodar como root dentro do
# contêiner não é necessário para nada aqui, e transforma qualquer falha
# de execução remota em falha com poderes totais.
USER node

# Informativo apenas. Quem manda na porta de verdade é a variável PORT
# injetada pela plataforma, que o `src/server.js` respeita
# (`process.env.PORT || 3001`). NÃO defina PORT à mão nas variáveis do
# serviço: a definida na mão ganha da injetada, o roteamento não acha o
# processo, e o deploy sobe sem responder.
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
