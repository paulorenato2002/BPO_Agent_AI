"""
Configuração do arquivador.

A raiz NUNCA é hardcodada. Ela muda de máquina para máquina (o caminho do
OneDrive tem o nome do tenant e do usuário) e muda se a empresa decidir
arquivar em outro lugar. Vem de `.env` ou de variável de ambiente.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

RAIZ_PROJETO = Path(__file__).resolve().parent.parent
# Mini-Sistemas/arquivador_docs -> Mini-Sistemas -> raiz do Agente BPO.
RAIZ_AGENTE = RAIZ_PROJETO.parent.parent


def _ler_env(arquivo: Path) -> None:
    """Lê um .env simples. Sem dependência externa — são cinco linhas."""
    if not arquivo.is_file():
        return

    for linha in arquivo.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, _, valor = linha.partition("=")
        chave = chave.strip()
        valor = valor.strip().strip('"').strip("'")
        # Chave vazia conta como AUSENTE, não como definida. `setdefault`
        # sozinho faria um `SUPABASE_SERVICE_ROLE_KEY=` em branco no primeiro
        # arquivo bloquear o valor real do segundo — e o erro apareceria como
        # "configure a credencial", com a credencial configurada ao lado.
        if valor and not os.environ.get(chave):
            os.environ[chave] = valor


def carregar_env(caminho: Path | None = None) -> None:
    """
    Carrega o ambiente do mini-sistema e, em seguida, o do projeto do agente.

    A ordem importa: `setdefault` faz o PRIMEIRO valor vencer, então o `.env`
    do mini-sistema manda e a raiz do agente só preenche o que faltou.

    Por que ler a raiz também: a credencial do Supabase já existe lá, para o
    chat. Pedir para copiá-la para um segundo arquivo criaria duas cópias do
    mesmo segredo, que envelhecem em ritmos diferentes — e a hora de descobrir
    que uma está velha é sempre a pior possível.

    Só o que interessa ao arquivador é aproveitado; nada do resto (chave da
    OpenAI, tokens do Google) é lido por este processo.
    """
    _ler_env(caminho or (RAIZ_PROJETO / ".env"))
    _ler_env(RAIZ_AGENTE / ".env.local")
    _ler_env(RAIZ_AGENTE / ".env")

    # O chat chama a mesma URL de `NEXT_PUBLIC_SUPABASE_URL` (o prefixo existe
    # para o navegador enxergar). Aqui o nome é SUPABASE_URL; a ponte evita
    # duplicar o valor só por causa do nome.
    if not os.environ.get("SUPABASE_URL"):
        publica = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "").strip()
        if publica:
            os.environ["SUPABASE_URL"] = publica


@dataclass(frozen=True)
class Config:
    raiz: Path
    diario: Path
    regras: Path

    @property
    def raiz_existe(self) -> bool:
        return self.raiz.is_dir()


def carregar_config() -> Config:
    carregar_env()

    bruto = os.environ.get("ARQUIVADOR_RAIZ", "").strip()
    if not bruto:
        raise SystemExit(
            "ARQUIVADOR_RAIZ não configurada.\n"
            "  Copie .env.example para .env e aponte para a pasta onde os\n"
            "  documentos devem ser arquivados (dentro do OneDrive sincronizado)."
        )

    return Config(
        raiz=Path(os.path.expandvars(bruto)).expanduser(),
        diario=Path(
            os.environ.get("ARQUIVADOR_DIARIO", str(RAIZ_PROJETO / "dados" / "diario.jsonl"))
        ),
        regras=Path(
            os.environ.get("ARQUIVADOR_REGRAS", str(RAIZ_PROJETO / "dados" / "regras.json"))
        ),
    )


def carregar_regras(caminho: Path) -> dict:
    """Regras exportadas do banco. Fonte de verdade continua sendo o banco."""
    if not caminho.is_file():
        raise SystemExit(
            f"Arquivo de regras não encontrado: {caminho}\n"
            "  Gere com `npm run exportar:regras` no projeto Agente BPO."
        )

    dados = json.loads(caminho.read_text(encoding="utf-8"))
    if not dados.get("regras"):
        raise SystemExit(f"{caminho} não tem regras. Regere o arquivo.")
    dados["regras_cruas"] = [dict(r) for r in dados["regras"]]
    dados["regras"] = [regra_para_pasta_existente(r) for r in dados["regras"]]
    return dados


def estrutura_atual() -> str:
    """Qual estrutura de pastas vale aqui. `existente` é a do disco de hoje."""
    return os.environ.get("ARQUIVADOR_ESTRUTURA") or "original"


def regra_para_pasta_existente(regra: dict, estrutura: str | None = None) -> dict:
    """
    Adapta uma regra de cliente à estrutura de pasta que já existe no disco.

    ESTA FUNÇÃO TEM UM GÊMEO em lib/arquivador/regras-pastas-existentes.ts.
    O TypeScript analisa e propõe o destino; o Python recalcula antes de copiar
    e RECUSA o item se o resultado divergir. Os dois têm de produzir o mesmo
    caminho e o mesmo nome, sempre.

    AS REGRAS `CLIENTE_*` MANTÊM SUAS PASTAS FIXAS (segmentos sem
    {PLACEHOLDER}). É o que mantém "AGENDAMENTOS" como pasta própria dentro da
    pasta do cliente, antes do ano. As regras antigas (`MENSAL_*`, `PROJETO_*`)
    descrevem uma estrutura que ainda não existe no disco e são achatadas.

    `estrutura` vem do payload de quem chamou. Depender só da variável de
    ambiente significava que um processo sem ela calculava pela regra crua
    enquanto o chat calculava pela adaptada — e todo item falhava com "o
    destino mudou desde a proposta", sem dizer que a causa era esta.

    Precisa ser aplicável a uma regra avulsa, e não só ao catálogo exportado,
    porque o worker recebe a regra dentro do payload da fila — fotografada do
    banco, crua.
    """
    if (estrutura or estrutura_atual()) != "existente":
        return regra
    if not regra.get("exige_empresa", True):
        return regra
    fixos = ([s for s in regra.get("caminho_modelo", []) if "{" not in s]
             if str(regra.get("codigo", "")).startswith("CLIENTE_") else [])
    return {
        **regra,
        "caminho_modelo": [*fixos, "{ANO}", "{COMPETENCIA_PASTA}"],
        "exige_competencia": True,
        "projeto": None,
        "padrao_nome": "{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}",
    }
