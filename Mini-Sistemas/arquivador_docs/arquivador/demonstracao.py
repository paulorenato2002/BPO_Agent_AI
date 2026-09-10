"""Teste visível com documento fictício. Não carrega .env nem acessa rede/IA."""
from dataclasses import asdict
import json
from pathlib import Path
import tempfile

from .arquivar import arquivar
from .caminhos import Contexto, Regra, montar_destino, montar_nome, trocar_versao_no_nome


def main():
    # Raiz curta no TEMP evita o limite de 255 caracteres no Windows.
    base = Path(tempfile.mkdtemp(prefix="bpo-demo-"))
    raiz = base / "destino"
    raiz.mkdir()
    origem = base / "documento_teste.txt"
    origem.write_text("DOCUMENTO FICTICIO\nEmpresa: TESTE\nCompetencia: 2026-09\n", encoding="utf-8")
    regra = Regra(codigo="DEMO", nome="Demonstração", escopo="mensal",
        caminho_modelo=["{ANO}", "{COMPETENCIA}", "DOCUMENTOS"],
        padrao_nome="{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}", exige_competencia=True)
    ctx = Contexto(empresa_codigo="999", empresa_nome="EMPRESA TESTE", pasta_clientes="CLIENTES",
        competencia="2026-09", tipo_documento="TESTE", extensao="txt")
    destino, nome = montar_destino(regra, ctx), montar_nome(regra, ctx)

    def copiar():
        return arquivar(origem, raiz, destino.segmentos, nome,
            trocar_versao=trocar_versao_no_nome, diario=base / "diario.jsonl")

    primeiro = copiar()
    repetido = copiar()
    origem.write_text("DOCUMENTO FICTICIO ALTERADO\n", encoding="utf-8")
    nova_versao = copiar()
    retomada = copiar()
    assert primeiro.status == "arquivado", primeiro.erro
    assert repetido.status == "ja_existia", repetido.erro
    assert nova_versao.versao == 2, nova_versao.erro
    assert retomada.status == "ja_existia" and retomada.versao == 2, retomada.erro
    assert origem.exists()
    assert Path(primeiro.caminho_final).read_text(encoding="utf-8").startswith("DOCUMENTO FICTICIO\n")
    print(json.dumps({"ok": True, "pasta_para_conferir": str(base),
        "primeira_copia": asdict(primeiro), "repeticao": repetido.status,
        "nova_versao": asdict(nova_versao), "retomada": retomada.status,
        "original_preservado": True, "chamadas_de_api": 0}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
