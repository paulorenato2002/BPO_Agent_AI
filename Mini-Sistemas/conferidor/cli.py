"""Entrada do agente: JSON no stdin, JSON no stdout.

    python cli.py json --stdin

Entrada: {"arquivos": [{"nome": "...", "base64": "..."}], "cliente": "", "empresa": "",
          "observacoes": "", "relacoes": "Nome no contas = Nome no banco",
          "dados_texto": "Fulano - R$ 150,00"}
Arquivos: PDF, XLSX, CSV ou TXT. `dados_texto` são listas (VT, VA...) coladas
na mensagem. Saída: lote.para_json. Responde JSON até em erro; o código de
saída é 0 sempre que a resposta foi escrita.
"""
import base64
import binascii
import json
import sys

from lote import conferir_lote, ler_relacoes, para_json

LIMITE_ARQUIVOS = 8
LIMITE_BYTES = 20 * 1024 * 1024
LIMITE_TEXTO = 20_000


def executar(pedido: dict) -> dict:
    if not isinstance(pedido, dict):
        return {"ok": False, "erros": ["Pedido inválido."]}
    arquivos = pedido.get("arquivos") or []
    dados_texto = str(pedido.get("dados_texto") or "")[:LIMITE_TEXTO]
    if not isinstance(arquivos, list) or not arquivos:
        return {"ok": False, "erros": ["Nenhum arquivo enviado."]}
    if len(arquivos) > LIMITE_ARQUIVOS:
        return {"ok": False, "erros": [f"No máximo {LIMITE_ARQUIVOS} arquivos por conferência."]}
    fontes = []
    for a in arquivos:
        nome = str((a or {}).get("nome") or "arquivo.pdf")
        try:
            dados = base64.b64decode((a or {}).get("base64") or "", validate=True)
        except (binascii.Error, ValueError):
            return {"ok": False, "erros": [f"{nome}: conteúdo ilegível."]}
        if len(dados) > LIMITE_BYTES:
            return {"ok": False, "erros": [f"{nome}: arquivo acima de 20 MB."]}
        fontes.append((nome, dados))
    relacoes, invalidas = ler_relacoes(str(pedido.get("relacoes") or ""))
    if invalidas:
        return {"ok": False, "erros": ["Relação inválida. Use: nome no contas a pagar = nome no banco, uma por linha."]}
    lote = conferir_lote(fontes, relacoes, str(pedido.get("observacoes") or ""), dados_texto)
    return para_json(lote, str(pedido.get("cliente") or ""), str(pedido.get("empresa") or ""))


def main(argv: list[str]) -> int:
    if argv[1:] != ["json", "--stdin"]:
        print("Uso: python cli.py json --stdin", file=sys.stderr)
        return 2
    try:
        pedido = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        resposta = executar(pedido)
    except json.JSONDecodeError:
        resposta = {"ok": False, "erros": ["Entrada não é JSON."]}
    except Exception as exc:  # a resposta precisa sair em JSON mesmo assim
        resposta = {"ok": False, "erros": [f"Falha inesperada na conferência ({type(exc).__name__})."]}
    sys.stdout.buffer.write(json.dumps(resposta, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
