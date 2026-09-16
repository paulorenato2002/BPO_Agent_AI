"""Entrada JSON do agente. Sem dados reais: as amostras só entram se instaladas localmente."""
import base64
import json
import subprocess
import sys
from pathlib import Path

import pytest

from cli import LIMITE_ARQUIVOS, executar

ROOT = Path(__file__).parent
AMOSTRAS = ROOT / "docs_amostra"


def arquivo(nome, dados):
    return {"nome": nome, "base64": base64.b64encode(dados).decode()}


def test_sem_arquivos():
    r = executar({"arquivos": []})
    assert r["ok"] is False and r["erros"] == ["Nenhum arquivo enviado."]


def test_limite_de_arquivos():
    r = executar({"arquivos": [arquivo(f"{i}.pdf", b"%PDF") for i in range(LIMITE_ARQUIVOS + 1)]})
    assert r["ok"] is False and "No máximo" in r["erros"][0]


def test_base64_invalido():
    r = executar({"arquivos": [{"nome": "x.pdf", "base64": "não é base64"}]})
    assert r["ok"] is False and "ilegível" in r["erros"][0]


def test_nao_pdf_bloqueia_sem_quebrar():
    r = executar({"arquivos": [arquivo("planilha.pdf", b"isto nao e pdf")]})
    assert r["ok"] is False
    assert any("leitura interrompida" in e for e in r["erros"])
    assert "relatorio_markdown" not in r


def test_relacao_invalida():
    r = executar({"arquivos": [arquivo("a.pdf", b"%PDF")], "relacoes": "sem sinal de igual"})
    assert r["ok"] is False and "Relação inválida" in r["erros"][0]


def test_processo_responde_json_ate_com_entrada_quebrada():
    p = subprocess.run([sys.executable, "cli.py", "json", "--stdin"], input=b"{quebrado", cwd=ROOT,
                       capture_output=True, timeout=60)
    assert p.returncode == 0
    assert json.loads(p.stdout.decode("utf-8")) == {"ok": False, "erros": ["Entrada não é JSON."]}


def test_uso_errado():
    p = subprocess.run([sys.executable, "cli.py"], cwd=ROOT, capture_output=True, timeout=60)
    assert p.returncode == 2


def test_amostras_pelo_processo():
    arq = AMOSTRAS / "esperado.json"
    if not arq.exists():
        pytest.skip("Amostras privadas não instaladas (não versionadas).")
    esperado = json.loads(arq.read_text(encoding="utf-8"))["conferencia"]
    for grupo, e in esperado.items():
        pdfs = [p for p in AMOSTRAS.glob("*.pdf") if p.name.upper().split("-")[0].strip() == grupo]
        pedido = {"arquivos": [arquivo(p.name, p.read_bytes()) for p in pdfs],
                  "cliente": "@Cliente Exemplo", "observacoes": "Observação de teste."}
        p = subprocess.run([sys.executable, "cli.py", "json", "--stdin"], input=json.dumps(pedido).encode(),
                           cwd=ROOT, capture_output=True, timeout=120)
        r = json.loads(p.stdout.decode("utf-8"))
        assert r["ok"] is True, (grupo, r["erros"])
        assert r["divergencias"] == len(e["divergencias"]), grupo
        assert len(r["documentos"]) == 3 and all(d["validado"] for d in r["documentos"])
        assert r["relatorio_markdown"].strip()
        linhas = r["mensagem_whatsapp"].splitlines()
        assert linhas[0].endswith("@Cliente Exemplo")
        assert "Observação de teste." in r["mensagem_whatsapp"]
        # Divergência não vai para o texto do cliente; vai para as pendências.
        assert r["pendencias_antes_de_enviar"]
