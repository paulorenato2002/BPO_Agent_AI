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


def carregar_env(caminho: Path | None = None) -> None:
    """Lê um .env simples. Sem dependência externa — são cinco linhas."""
    arquivo = caminho or (RAIZ_PROJETO / ".env")
    if not arquivo.is_file():
        return

    for linha in arquivo.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, _, valor = linha.partition("=")
        os.environ.setdefault(chave.strip(), valor.strip().strip('"').strip("'"))


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
    return dados
