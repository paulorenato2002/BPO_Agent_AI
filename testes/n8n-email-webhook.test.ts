import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  autenticarWebhookN8n,
  CONTA_EMAIL_EFFECTIVE,
  validarEventoEmailN8n,
} from "@/lib/integracoes/n8n-email-webhook";

const segredoOriginal = process.env.N8N_EMAIL_WEBHOOK_SECRET;

afterEach(() => {
  if (segredoOriginal === undefined) delete process.env.N8N_EMAIL_WEBHOOK_SECRET;
  else process.env.N8N_EMAIL_WEBHOOK_SECRET = segredoOriginal;
});

describe("webhook de e-mail do n8n", () => {
  test("aceita somente bearer token exato e forte", () => {
    const segredo = "a".repeat(48);
    process.env.N8N_EMAIL_WEBHOOK_SECRET = segredo;
    assert.equal(autenticarWebhookN8n(`Bearer ${segredo}`), true);
    assert.equal(autenticarWebhookN8n("Bearer errado"), false);
    assert.equal(autenticarWebhookN8n(null), false);
  });

  test("rejeita configuração com segredo curto", () => {
    process.env.N8N_EMAIL_WEBHOOK_SECRET = "curto";
    assert.equal(autenticarWebhookN8n("Bearer curto"), false);
  });

  test("normaliza um evento válido", () => {
    const resultado = validarEventoEmailN8n({
      versao: 1,
      eventoId: "msg-123",
      threadId: "thread-1",
      contaEmail: CONTA_EMAIL_EFFECTIVE.toUpperCase(),
      remetente: "Cliente <cliente@example.com>",
      destinatarios: [CONTA_EMAIL_EFFECTIVE],
      cc: [],
      assunto: "Documentos",
      resumo: "Segue anexo.",
      corpoTexto: "Olá",
      recebidoEm: "2026-09-17T14:00:00-03:00",
      anexos: [{ id: "att-1", nome: "relatorio.pdf", mimeType: "application/pdf", tamanhoBytes: 42 }],
    });
    assert.equal(resultado.ok, true);
    if (resultado.ok) {
      assert.equal(resultado.evento.contaEmail, CONTA_EMAIL_EFFECTIVE);
      assert.equal(resultado.evento.recebidoEm, "2026-09-17T17:00:00.000Z");
      assert.equal(resultado.evento.anexos.length, 1);
    }
  });

  test("bloqueia outra caixa de e-mail", () => {
    const resultado = validarEventoEmailN8n({
      versao: 1,
      eventoId: "msg-123",
      contaEmail: "outra@gmail.com",
      remetente: "cliente@example.com",
      recebidoEm: "2026-09-17T17:00:00Z",
    });
    assert.deepEqual(resultado, { ok: false, erro: "conta_nao_autorizada" });
  });

  test("rejeita versão e data inválidas", () => {
    assert.deepEqual(validarEventoEmailN8n({ versao: 2 }), { ok: false, erro: "versao_invalida" });
    assert.deepEqual(validarEventoEmailN8n({
      versao: 1,
      eventoId: "x",
      contaEmail: CONTA_EMAIL_EFFECTIVE,
      remetente: "a@b.com",
      recebidoEm: "ontem",
    }), { ok: false, erro: "data_invalida" });
  });
});
