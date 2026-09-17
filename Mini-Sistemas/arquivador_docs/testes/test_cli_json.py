"""Entrada JSON do agente: acentos, estrutura e destino divergente."""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]


def _raiz_do_disco() -> Path | None:
    """Raiz do arquivador, lida do .env SEM carregar o ambiente.

    `carregar_config()` escreve em os.environ, e isso vazaria para os outros
    testes deste pacote — que rodam no mesmo processo e esperam o ambiente cru.
    """
    bruto = os.environ.get("ARQUIVADOR_RAIZ")
    if not bruto:
        try:
            linhas = (RAIZ / ".env").read_text(encoding="utf-8").splitlines()
        except OSError:
            return None
        bruto = next((l.split("=", 1)[1] for l in linhas if l.startswith("ARQUIVADOR_RAIZ=")), "")
    bruto = bruto.strip().strip('"').strip("'")
    return Path(bruto) if bruto else None


def empresa_do_disco():
    """Uma pasta de cliente que exista nesta máquina.

    Lida do disco, nunca escrita aqui: código e nome de cliente não entram no
    repositório. Sem raiz configurada, o teste é pulado.
    """
    raiz = _raiz_do_disco()
    if not raiz:
        pytest.skip("Sem raiz do arquivador configurada nesta máquina.")
    try:
        pasta = next(p.name for p in sorted((raiz / "01_CLIENTES_ATIVOS").iterdir())
                     if p.is_dir() and re.match(r"^\d+-", p.name))
    except (OSError, StopIteration):
        pytest.skip("Sem pasta de cliente no disco desta máquina.")
    codigo, nome = pasta.split("-", 1)
    return {"empresa_codigo": codigo, "empresa_nome": nome, "pasta": pasta}


def chamar(payload: dict) -> dict:
    arquivo = Path(tempfile.gettempdir()) / "documento_de_teste.pdf"
    arquivo.write_bytes(b"%PDF teste")
    payload = {"arquivo": str(arquivo), "simular": True, **payload}
    # ensure_ascii=False de propósito: é assim que o agente (JSON.stringify)
    # manda, e era o que quebrava a leitura no Windows.
    p = subprocess.run([sys.executable, "-m", "arquivador", "json", "--stdin"],
                       input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       cwd=RAIZ, capture_output=True, timeout=60)
    return json.loads(p.stdout.decode("utf-8"))


BASE = {"regra": "CLIENTE_DOCUMENTO", "empresa_ativa": True, "competencia": "2026-09",
        "tipo_documento": "NOTA_FISCAL", "estrutura": "existente"}


@pytest.fixture
def base():
    e = empresa_do_disco()
    return {**BASE, "empresa_codigo": e["empresa_codigo"], "empresa_nome": e["empresa_nome"]}, e["pasta"]


def test_acento_no_payload_chega_inteiro(base):
    dados, _ = base
    r = chamar({**dados, "instituicao": "ITAÚ"})
    assert r["ok"], r
    assert r["nome_final"].endswith("_NOTA_FISCAL_ITAU_v1.pdf"), r["nome_final"]


def test_estrutura_do_pedido_manda(base):
    dados, _ = base
    existente = chamar({**dados, "instituicao": None})
    original = chamar({**dados, "instituicao": None, "estrutura": "original"})
    assert "/09.2026/" in existente["caminho_relativo"]
    assert "/2026-09/" in original["caminho_relativo"]


def test_destino_divergente_mostra_os_dois_caminhos(base):
    dados, _ = base
    r = chamar({**dados, "instituicao": None, "caminho_confirmado": "01_CLIENTES_ATIVOS/outro/lugar.pdf"})
    assert r["ok"] is False
    assert r["caminho_confirmado"] == "01_CLIENTES_ATIVOS/outro/lugar.pdf"
    assert r["caminho_calculado"].endswith("_NOTA_FISCAL_v1.pdf")
    assert "Proposta:" in r["erro"] and "Calculado:" in r["erro"]


def test_pasta_agendamentos_do_cliente(base):
    dados, pasta = base
    r = chamar({**dados, "regra": "CLIENTE_AGENDAMENTOS", "instituicao": "Itaú",
                "tipo_documento": "RELATORIO_AGENDAMENTOS"})
    assert r["ok"], r
    assert f"/{pasta}/AGENDAMENTOS/2026/09.2026/" in r["caminho_relativo"], r["caminho_relativo"]
