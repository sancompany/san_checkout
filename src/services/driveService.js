/**
 * SAN CHECKOUT v2 — src/services/driveService.js
 * Arquivamento de nota fiscal (VISAO_COMPLETA.md seção 8) — uma pasta
 * por contratante dentro da pasta raiz, criada automaticamente na
 * primeira nota daquele projeto.
 */

import { Readable } from 'node:stream';
import { getClienteDrive } from '../config/googleDrive.js';

function obterPastaRaizId() {
  const raiz = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!raiz) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID não configurado no .env.');
  return raiz;
}

/** Cria a subpasta do contratante dentro da pasta raiz. Chamar só
 *  quando `contratantes.drive_folder_id` ainda for nulo. */
export async function criarPastaContratante(nomeContratante) {
  const drive = getClienteDrive();

  const resposta = await drive.files.create({
    requestBody: {
      name: nomeContratante,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [obterPastaRaizId()]
    },
    fields: 'id'
  });

  return resposta.data.id;
}

/** Baixa o PDF da nota direto da URL que a Asaas manda no webhook. */
export async function baixarPdf(url) {
  const resposta = await fetch(url);
  if (!resposta.ok) {
    throw new Error(`Falha ao baixar PDF da nota fiscal (HTTP ${resposta.status}).`);
  }
  const arrayBuffer = await resposta.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Sobe o PDF já baixado pra pasta do contratante. */
export async function uploadPdfNotaFiscal(pastaId, nomeArquivo, bufferPdf) {
  const drive = getClienteDrive();

  const resposta = await drive.files.create({
    requestBody: { name: nomeArquivo, parents: [pastaId] },
    media: { mimeType: 'application/pdf', body: Readable.from(bufferPdf) },
    fields: 'id'
  });

  return resposta.data.id;
}
