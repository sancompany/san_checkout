-- 0005 — destinos de retorno pós-pagamento (returnUrl)
--
-- O checkout passou a honrar `?returnUrl=` na URL: depois do pagamento
-- confirmado, o comprador ganha um botão (e uma contagem regressiva) de
-- volta para o site do contratante, em vez de ficar parado na tela de
-- sucesso sem próximo passo.
--
-- `returnUrl` vem da barra de endereço, ou seja: de quem montou o link,
-- que não é necessariamente o contratante. Honrar qualquer endereço
-- transformaria o checkout em open redirect — link com o nosso domínio
-- na frente levando para onde o atacante quiser. Por isso o destino só
-- é aceito se a ORIGEM dele estiver na lista deste contratante.
--
-- A lista tem duas partes: a origem de `api_base_url`, sempre permitida
-- em código (ela já recebe a `X-Checkout-Key` a cada pedido — mandar o
-- comprador para lá não concede nada novo), mais o que for cadastrado
-- nesta coluna. Esta coluna existe porque o caso comum é a API viver em
-- `api.loja.com.br` e a vitrine em `www.loja.com.br`: exigir host
-- idêntico quebraria o uso real.
--
-- Comparação por origem (esquema+host+porta), caminho ignorado — a
-- regra inteira e os bypasses que ela fecha estão em
-- `src/utils/retornoSeguro.js`.
--
-- Nulo (o default) = contratante não aceita retorno nenhum além da
-- própria origem da API. Nada quebra: `returnUrl` fora da lista é
-- simplesmente ignorado, e o checkout segue funcionando como antes.

alter table contratantes
  add column if not exists retorno_dominios text[];

comment on column contratantes.retorno_dominios is
  'Origens https extras autorizadas a receber o comprador de volta depois do pagamento (returnUrl). A origem de api_base_url já é permitida sem estar aqui. Validado por src/utils/retornoSeguro.js.';
