/**
 * public/js/modules/retorno.js
 *
 * O caminho de volta para a loja, depois do pagamento confirmado.
 *
 * ── O buraco que isto fecha ────────────────────────────────────────
 *
 * Até aqui, quem pagava ficava parado na tela do checkout: o polling
 * trocava a mensagem para "Pagamento confirmado! Obrigado.", acendia a
 * bolinha verde — e acabava. Sem botão, sem link, sem próximo passo. A
 * pessoa que veio de uma loja tinha de fechar a aba e achar o caminho
 * de volta sozinha. `returnUrl` era simplesmente ignorado.
 *
 * ── As duas regras que não se negociam ──────────────────────────────
 *
 * 1. **Só depois de confirmado.** `ativarRetorno` é chamado de dentro
 *    do `aoConfirmar` de cada método, nunca antes. Mandar alguém de
 *    volta com o Pix ainda aberto é tirar da tela o código que ela
 *    precisa — o pagamento morreria na metade.
 *
 * 2. **O destino nunca é decidido aqui.** Este módulo só usa o que o
 *    backend já aprovou (`retornoUrl` na resposta de
 *    `/api/checkout/pedido/…`). O navegador recebe a resposta pronta e
 *    nunca a lista de origens do contratante. Validar no front seria
 *    validar do lado que o atacante controla, e publicaria a lista de
 *    quebra. A regra inteira está em `src/utils/retornoSeguro.js`.
 *
 * ── A contagem regressiva é cancelável, e isso é de propósito ───────
 *
 * Redirecionar sozinho é bom para quem terminou e ruim para quem ainda
 * está lendo o comprovante, anotando o número do pedido ou tirando
 * print. O botão leva na hora; a contagem leva sozinha em 10 s; e
 * qualquer clique, rolagem ou tecla cancela a contagem e deixa só o
 * botão. Ninguém é arrancado da tela no meio de uma leitura.
 */

/** Tempo até o retorno automático. Longo o bastante para ler a
 *  confirmação, curto o bastante para não parecer travado. */
const SEGUNDOS_ATE_VOLTAR = 10;

let destinoAprovado = null;
let nomeDaLoja = null;
let intervalo = null;

/**
 * Guarda o destino que o BACKEND aprovou. `null`/ausente = este
 * checkout não tem retorno, e a tela segue como sempre foi.
 *
 * @param {string|null} url — `retornoUrl` da resposta do backend
 * @param {string|null} [nomeContratante] — só para rotular o botão
 */
export function definirRetorno(url, nomeContratante) {
  destinoAprovado = typeof url === 'string' && url ? url : null;
  nomeDaLoja = typeof nomeContratante === 'string' && nomeContratante ? nomeContratante : null;
}

export function temRetorno() {
  return destinoAprovado !== null;
}

/**
 * `?returnUrl=…` da URL do checkout, pronto para repassar ao backend.
 * Devolve string vazia quando não veio nada — o checkout funciona igual
 * sem ele, só não oferece o caminho de volta.
 *
 * Repassa o valor CRU (só percent-encoded para caber numa query): a
 * conferência é do backend, e mexer no valor antes de mandar só criaria
 * a chance de o que foi validado não ser o que será usado.
 */
export function montarRetornoNaQuery() {
  const bruto = new URLSearchParams(window.location.search).get('returnUrl');
  if (!bruto) return '';
  return `?returnUrl=${encodeURIComponent(bruto)}`;
}

function cancelarContagem(textoBotao) {
  if (intervalo) {
    clearInterval(intervalo);
    intervalo = null;
  }
  const aviso = document.getElementById('retorno-aviso');
  if (aviso) aviso.textContent = '';
  const botao = document.getElementById('retorno-link');
  if (botao && textoBotao) botao.textContent = textoBotao;
}

/**
 * Mostra o bloco de volta à loja. Chamado no `aoConfirmar` de cada
 * método de pagamento.
 */
export function ativarRetorno() {
  if (!destinoAprovado) return;

  const bloco = document.getElementById('retorno-bloco');
  const link = document.getElementById('retorno-link');
  const aviso = document.getElementById('retorno-aviso');
  if (!bloco || !link || !aviso) return;

  // Já ativo: sai. Sem isto, uma segunda confirmação (troca de método,
  // webhook repetido) somaria um segundo `setInterval` sobre o mesmo
  // destino — dois contadores correndo, e o primeiro sem ninguém para
  // pará-lo.
  if (intervalo || !bloco.classList.contains('hidden')) return;

  // `href` recebe um valor que o backend já aprovou como https de
  // origem cadastrada; o rótulo entra por `textContent`, nunca por
  // `innerHTML` — nome de contratante é dado de banco, e dado de banco
  // não vira marcação.
  link.href = destinoAprovado;
  link.textContent = nomeDaLoja ? `Voltar para ${nomeDaLoja}` : 'Voltar para a loja';
  bloco.classList.remove('hidden');

  let restante = SEGUNDOS_ATE_VOLTAR;
  aviso.textContent = `Voltando automaticamente em ${restante}s...`;

  intervalo = setInterval(() => {
    restante -= 1;

    if (restante <= 0) {
      cancelarContagem();
      // `replace` e não `assign`: o checkout já cumpriu seu papel e não
      // deve ficar no histórico. Voltar no navegador tem de levar a
      // pessoa para antes do checkout, não de novo para uma tela de
      // pagamento já pago, onde ela clicaria de novo em "gerar Pix".
      window.location.replace(destinoAprovado);
      return;
    }

    aviso.textContent = `Voltando automaticamente em ${restante}s...`;
  }, 1000);

  // Qualquer sinal de que a pessoa ainda está usando a tela cancela o
  // automático. `once` em cada um: cancelar é irreversível de propósito
  // — quem parou a contagem decidiu ficar, e não se rearma sozinho.
  for (const evento of ['click', 'keydown', 'wheel', 'touchmove']) {
    window.addEventListener(evento, () => cancelarContagem(), { once: true });
  }
}

/** Interrompe o retorno automático — usado quando a tela sai do estado
 *  de sucesso (troca de método, por exemplo). */
export function pararRetorno() {
  cancelarContagem();
}
