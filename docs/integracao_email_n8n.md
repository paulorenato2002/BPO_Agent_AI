# Integração Gmail pelo n8n Cloud

## Desenho inicial

```text
effective.bpo@gmail.com
        ↓ OAuth gerenciado pelo n8n Cloud
Gmail Trigger (somente novas mensagens)
        ↓ JSON + metadados dos anexos
POST /api/integracoes/email/n8n/receber
        ↓ service_role, sem credencial Google
email_eventos (Supabase)
```

O Google fica conectado apenas ao n8n. O Agente BPO recebe eventos autenticados
e nunca conhece o refresh token da conta. Nesta primeira etapa não há envio,
resposta, exclusão, marcação como lido nem download do conteúdo dos anexos.

## Contrato do webhook

Cabeçalhos:

```http
Authorization: Bearer <N8N_EMAIL_WEBHOOK_SECRET>
Content-Type: application/json
```

Corpo:

```json
{
  "versao": 1,
  "eventoId": "id da mensagem no Gmail",
  "threadId": "id da conversa no Gmail",
  "contaEmail": "effective.bpo@gmail.com",
  "remetente": "Cliente <cliente@example.com>",
  "destinatarios": ["effective.bpo@gmail.com"],
  "cc": [],
  "assunto": "Documentos para conferência",
  "resumo": "Trecho curto fornecido pelo Gmail",
  "corpoTexto": "Corpo em texto simples, se disponível",
  "recebidoEm": "2026-09-17T14:00:00-03:00",
  "anexos": [
    {
      "id": "identificador do anexo no Gmail",
      "nome": "relatorio.pdf",
      "mimeType": "application/pdf",
      "tamanhoBytes": 12345
    }
  ]
}
```

O limite do corpo é 512 KiB. Arquivos binários não passam por este endpoint.
Mensagens repetidas são aceitas sem criar duplicata, usando o ID do Gmail.

## Configuração no n8n Cloud

1. Crie uma credencial Google Mail e clique em **Sign in with Google**.
2. Entre com `effective.bpo@gmail.com`.
3. Crie um workflow com **Gmail Trigger** em `Message Received`.
4. Durante o teste, filtre para uma etiqueta exclusiva, como `AGENTE_BPO_TESTE`.
5. Adicione um node de transformação para montar o JSON do contrato acima.
6. Adicione **HTTP Request** com método `POST`, URL do endpoint publicado e
   header `Authorization: Bearer ...`.
7. Primeiro execute com a URL de teste. Publique o workflow somente depois de
   o evento aparecer uma vez na tabela `email_eventos`.

O segredo deve ser diferente de qualquer senha e ter pelo menos 32 caracteres.
Guarde o mesmo valor em `N8N_EMAIL_WEBHOOK_SECRET` na Vercel e na credencial de
header do n8n.
