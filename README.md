## Agente BPO

Interface de chat (Next.js) que conversa com um agente OpenAI com acesso de
leitura/escrita ao banco Supabase do BPO, via function calling.

### Vercel + Python no PC

O destino padrão agora é uma fila no Supabase: depois da confirmação, o worker
Python no PC baixa do Storage e arquiva na pasta sincronizada. O servidor web
não precisa executar Python. Veja [como testar e ativar](docs/worker_local.md).

Teste demonstrativo, sem API: na pasta `Mini-Sistemas/arquivador_docs`, execute
`python -m arquivador.demonstracao`. Para consumir a fila real, use
`python -m arquivador.worker` após configurar e aplicar a migration indicada.

### O repositório tem mais que o agente

| Pasta | O que é |
|---|---|
| (raiz) | O agente: Next.js, banco, ferramentas do modelo |
| [`Mini-Sistemas/`](Mini-Sistemas/) | Processos com etapas, estado e tratamento de erro. Chamáveis pelo agente, pelo n8n ou por agendador. |
| [`Ferramentas Auxiliares/`](Ferramentas%20Auxiliares/) | Scripts avulsos: uma coisa só, rodada à mão, sem guardar estado. |

Como as peças se encaixam no arquivamento de documentos:

```
usuário anexa documento no chat
        │
        ▼
   agente ──── lê, identifica empresa, competência e tipo
        │
        ▼
 Mini-Sistemas/arquivador_docs ──── monta o caminho, renomeia,
        │                            cria pastas e arquiva
        ▼
 pasta sincronizada do OneDrive ──── o OneDrive sobe para a nuvem
```

O agente **classifica**; o mini-sistema **arquiva**. Cada um faz uma coisa.

O acesso por API ao OneDrive dependia de uma aprovação do tenant que não
estava disponível. Como o OneDrive já sincroniza as pastas na máquina, o
arquivador escreve só no disco local e deixa a sincronização com o próprio
OneDrive — sem API, sem OAuth, sem espera.

### Como funciona

- `app/page.tsx` — interface de texto (chat).
- `app/api/chat/route.ts` — recebe o histórico da conversa, chama a OpenAI
  com as tools de banco e roda o loop de tool calls até o modelo responder
  em texto.
- `lib/db-tools.ts` — as tools de banco que o modelo pode chamar:
  `listar_tabelas`, `descrever_tabela`, `consultar_dados`, `inserir_dado`,
  `inserir_varios_dados` (import em lote), `atualizar_dado`, `deletar_dado`.
- `lib/db-schema.json` — snapshot das 26 tabelas do schema `public` (nome,
  tipo, PK/FK de cada coluna), gerado a partir do endpoint OpenAPI do
  PostgREST (`GET /rest/v1/`). Serve de allowlist: o agente só opera em
  tabelas que existem de fato. Se o schema do banco mudar, regenere esse
  arquivo.
- `lib/supabase-admin.ts` — cliente Supabase com a **service role key**
  (ignora RLS). Só é importado por código de servidor (`import "server-only"`
  barra importação acidental em componente de cliente).

### Arquivos anexados (planilha/CSV/PDF/txt)

- `app/api/upload/route.ts` — recebe o arquivo (multipart/form-data), extrai
  o conteúdo (`lib/file-extract.ts`), salva o arquivo original no Supabase
  Storage (`lib/file-store.ts`, bucket privado `anexos-agente`) e devolve um
  resumo + uma **prévia pequena** (8 linhas ou ~1500 caracteres) — nunca o
  arquivo inteiro.
- A mensagem que vai pro modelo carrega só essa prévia, não o arquivo
  completo, mesmo que ele tenha milhares de linhas — isso evita estourar o
  contexto e evita reenviar o arquivo inteiro a cada turno da conversa.
- `lib/file-tools.ts` — tools que o modelo usa pra ir além da prévia:
  - `consultar_arquivo_anexado` — lista/filtra/pagina linhas de uma
    planilha/CSV anexada.
  - `agregar_arquivo_anexado` — soma/conta por categoria direto no servidor
    (sem o modelo precisar ler linha por linha) — é o caminho certo pra
    "quanto foi gasto com X" em arquivos grandes.
  - `ler_arquivo_texto_anexado` — pagina o texto de um PDF/txt além da
    prévia.
  Essas tools reparseiam o arquivo original a partir do Storage a cada
  chamada (simples, sem cache) — normal ser ~200-500ms por chamada num
  arquivo de alguns milhares de linhas.
- Suporta múltiplos arquivos numa mesma mensagem (`input type="file" multiple`).
- Tetos de segurança (não são limites de uso normal): 20MB por arquivo,
  200.000 linhas ou 500.000 caracteres de texto — só pra não estourar
  memória com um arquivo patológico.
- **Vercel Hobby limita o corpo da requisição a ~4.5MB** independente do que
  configuramos aqui — arquivos maiores que isso vão falhar no deploy mesmo
  passando local. Se isso for um problema real, precisa de upload direto
  pro Storage (signed URL) em vez de passar pela Route Handler.

### Rodar local

```bash
npm install
npm run dev
```

Abre em [http://localhost:3000](http://localhost:3000).

### Variáveis de ambiente

Ver [.env.example](.env.example). O `.env` já está preenchido neste projeto
e é ignorado pelo git (`.gitignore`).

### Deploy na Vercel

```bash
npx vercel
```

Na primeira vez ele pede login (abre o navegador) e pergunta se quer linkar
a um projeto novo. Depois, configure as mesmas variáveis do `.env` em
Project Settings > Environment Variables no painel da Vercel (elas não vão
no deploy automaticamente, dado que `.env` é ignorado pelo git).

### Segurança

- A `SUPABASE_SERVICE_ROLE_KEY` só é usada no servidor — nunca aparece no
  bundle do navegador nem deve ser prefixada com `NEXT_PUBLIC_`.
- `deletar_dado` é delete físico. O prompt do sistema instrui o modelo a
  pedir confirmação explícita antes de chamar essa tool, mas isso é uma
  instrução de prompt, não uma trava técnica — trate este ambiente como
  teste, não como produção, até revisar essa política.
