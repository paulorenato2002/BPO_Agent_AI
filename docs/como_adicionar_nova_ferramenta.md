# Como adicionar uma nova ferramenta ao agente

Este documento explica como conectar uma aplicação (Python, serviço interno,
integração externa) ao agente da Effective.

> **Estado atual:** nenhuma ferramenta de negócio está conectada. O registro
> existe vazio e preparado. Este guia é o caminho para a primeira.

---

## O modelo mental

O agente **não executa** a regra de negócio. Ele:

1. entende o pedido,
2. reúne o contexto (empresa, competência, documentos),
3. **chama a ferramenta**,
4. acompanha a execução,
5. apresenta o resultado.

A ferramenta é quem faz o trabalho. Ela pode ser uma função TypeScript, uma
chamada HTTP para uma aplicação Python, ou qualquer outra coisa — o agente não
precisa saber.

O catálogo de ferramentas vive **no código** (`lib/ferramentas/registro.ts`).
O banco guarda apenas o **registro das execuções** (`execucoes_ferramenta`) e,
nas etapas de rotina, o **código** da ferramenta (`etapas_modelo_rotina.ferramenta_codigo`).
Nenhum código executável é armazenado no banco.

---

## Passo a passo

### 1. Crie a aplicação ou o método

Se for uma aplicação Python separada, exponha um endpoint HTTP com entrada e
saída em JSON. O agente nunca chama o Python diretamente — ele chama o handler
da ferramenta, e o handler chama a aplicação.

### 2. Defina entrada e saída

Escreva os tipos primeiro. A entrada é o que o **modelo** vai preencher, então
os nomes dos campos precisam ser autoexplicativos.

```ts
type EntradaRevisaoDre = {
  empresaId: string;
  competenciaId: string;
  documentoIds: string[];
};

type SaidaRevisaoDre = {
  relatorioDocumentoId: string;
  inconsistenciasEncontradas: number;
};
```

### 3. Crie o handler

Arquivo sugerido: `lib/ferramentas/catalogo/revisao-dre.ts`.

```ts
import "server-only";
import type { DefinicaoFerramenta } from "../tipos";

export const revisaoDre: DefinicaoFerramenta<EntradaRevisaoDre, SaidaRevisaoDre> = {
  codigo: "revisar_dre",
  nome: "Revisão de DRE",
  // Esta descrição é o que o MODELO lê para decidir quando usar. Seja
  // específico sobre QUANDO usar e o que ela precisa receber.
  descricao:
    "Revisa a DRE de uma empresa em uma competência específica, a partir dos " +
    "documentos já registrados. Use quando o usuário pedir revisão, conferência " +
    "ou fechamento de DRE. Exige empresa e competência identificadas.",
  versao: "1",

  schemaEntrada: {
    type: "object",
    properties: {
      empresaId:     { type: "string", description: "UUID da empresa." },
      competenciaId: { type: "string", description: "UUID da competência." },
      documentoIds:  {
        type: "array",
        items: { type: "string" },
        description: "UUIDs dos documentos a considerar.",
      },
    },
    required: ["empresaId", "competenciaId", "documentoIds"],
    additionalProperties: false,
  },

  // Nunca confie na saída do modelo: valide de verdade.
  validarEntrada: (dado) => {
    const problemas: string[] = [];
    const d = dado as Partial<EntradaRevisaoDre>;
    if (!d?.empresaId) problemas.push("empresaId é obrigatório");
    if (!d?.competenciaId) problemas.push("competenciaId é obrigatório");
    if (!Array.isArray(d?.documentoIds) || d.documentoIds.length === 0) {
      problemas.push("documentoIds precisa ter ao menos um documento");
    }
    return problemas.length
      ? { valido: false, problemas }
      : { valido: true, dado: d as EntradaRevisaoDre };
  },

  nivelRisco: "medio",
  modo: "sincrono",
  timeoutMs: 120_000,
  tentativas: 2,
  exigeAprovacao: false,

  // Deixe `false` até terminar de testar. O agente só enxerga o que está true.
  disponivelParaAgente: false,

  handler: async (entrada, contexto) => {
    const resposta = await fetch(`${process.env.APP_DRE_URL}/revisar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entrada),
    });

    if (!resposta.ok) {
      // Erro explícito. Nunca devolva ok:true sem confirmação real.
      return { ok: false, erro: `Aplicação de DRE retornou HTTP ${resposta.status}.` };
    }

    const saida = (await resposta.json()) as SaidaRevisaoDre;
    return {
      ok: true,
      saida,
      // `resumo` é o que o agente conta ao usuário. Escreva em português claro.
      resumo: `Revisão concluída: ${saida.inconsistenciasEncontradas} inconsistência(s).`,
    };
  },
};
```

### 4. Registre no backend

Em `lib/ferramentas/catalogo/index.ts`:

```ts
import { registroFerramentas } from "../registro";
import { revisaoDre } from "./revisao-dre";

registroFerramentas.registrar(revisaoDre);
```

### 5. Configure quando o agente pode usar

- `disponivelParaAgente: false` → existe no registro, o agente **não** vê.
- `disponivelParaAgente: true` → entra em `comoToolsOpenAI()` e o modelo passa
  a poder chamá-la.

Mantenha `false` até os testes passarem.

### 6. Associe a uma rotina (opcional)

Se a ferramenta é uma etapa de uma rotina operacional:

```sql
insert into public.etapas_modelo_rotina
  (modelo_rotina_id, codigo, nome, ordem, tipo_etapa, ferramenta_codigo)
values
  ('<uuid-do-modelo>', 'REVISAO_DRE', 'Revisar DRE', 3, 'aplicacao', 'revisar_dre');
```

O banco **exige** `ferramenta_codigo` quando `tipo_etapa = 'aplicacao'` — não
existe etapa de aplicação órfã.

### 7. Teste

Crie `testes/ferramentas/revisao-dre.test.ts` cobrindo, no mínimo:

- entrada inválida é rejeitada antes de qualquer efeito colateral;
- sucesso devolve `ok: true` com a saída normalizada;
- erro da aplicação vira `ok: false`, nunca sucesso;
- timeout é respeitado;
- idempotência: a mesma `chaveIdempotencia` não executa duas vezes.

```bash
npm test
```

### 8. Ative

Mude `disponivelParaAgente` para `true` e faça deploy.

---

## O que o registro faz por você

Ao chamar `executarFerramenta(codigo, entrada, contexto)`, o registro cuida de:

| Etapa | O que acontece |
|---|---|
| Validação | `validarEntrada` roda **antes** de qualquer efeito colateral |
| Registro | Cria a linha em `execucoes_ferramenta` antes de executar |
| Idempotência | Mesma `chaveIdempotencia` devolve o resultado anterior |
| Aprovação | Se `exigeAprovacao`, cria `aprovacoes_operacionais` e para |
| Timeout | Aborta em `timeoutMs` |
| Tentativas | Repete falhas de infraestrutura (nunca erro de regra) |
| Resultado | Grava saída, duração e status |
| Evento | Registra em `eventos_operacionais` (append-only) |

Você **não** precisa escrever nada disso no handler.

---

## Regras que não se negociam

1. **Nunca reporte sucesso sem confirmação real.** Se a aplicação não respondeu
   ou não confirmou, é `ok: false`.
2. **Nunca dê SQL livre ao agente.** Toda operação passa por método tipado.
3. **Nunca coloque segredo no banco nem em log.** Credenciais só em variável de
   ambiente do servidor.
4. **`service_role` nunca vai para o frontend.** Nada de `NEXT_PUBLIC_` em chave
   sensível.
5. **Ação destrutiva ou externa exige `exigeAprovacao: true`.** Exclusões,
   envio de e-mail, pagamento, alteração em sistema de terceiro.
6. **Descrição é interface.** O modelo escolhe a ferramenta pela descrição — se
   ela for vaga, ele erra a escolha.

---

## Escolhendo o nível de risco

| Nível | Quando | Aprovação |
|---|---|---|
| `baixo` | Só leitura, sem efeito externo | não |
| `medio` | Escreve dado interno | não |
| `alto` | Escreve em sistema de terceiro, envia comunicação | recomendada |
| `critico` | Exclusão, pagamento, ação irreversível | **obrigatória** |

---

## Checklist antes de ativar

- [ ] `validarEntrada` rejeita entrada malformada
- [ ] Handler nunca devolve `ok: true` sem confirmação real
- [ ] `timeoutMs` compatível com o tempo real da aplicação
- [ ] `exigeAprovacao: true` se a ação for destrutiva ou externa
- [ ] Descrição diz claramente **quando** usar
- [ ] Testes passam (`npm test`)
- [ ] Typecheck e lint limpos (`npm run verificar`)
- [ ] Nenhum segredo no código ou em log
