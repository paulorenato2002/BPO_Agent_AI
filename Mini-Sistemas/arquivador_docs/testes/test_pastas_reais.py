import pytest
from arquivador.caminhos import Contexto, Regra, montar_destino, ErroCaminho
from arquivador.pasta_cliente import resolver_pasta_cliente

def test_usa_nome_real_e_mes_ano(tmp_path):
    pasta = tmp_path / "01_CLIENTES_ATIVOS" / "210-TL ACADEMIA"
    pasta.mkdir(parents=True)
    regra = Regra(codigo="CLIENTE_DOCUMENTO", nome="Documento", escopo="mensal",
        caminho_modelo=["{ANO}", "{COMPETENCIA_PASTA}"], padrao_nome="", exige_competencia=True)
    ctx = Contexto(empresa_codigo="210", empresa_nome="TL ACADEMIA DE GINASTICA LTDA",
        pasta_clientes="01_CLIENTES_ATIVOS", competencia="2026-07")
    resolver_pasta_cliente(tmp_path, regra, ctx)
    assert montar_destino(regra, ctx).caminho_relativo == "01_CLIENTES_ATIVOS/210-TL ACADEMIA/2026/07.2026"
    assert not (tmp_path / "01_CLIENTES_ATIVOS" / "210").exists()

def test_nao_escolhe_entre_duas_pastas_do_mesmo_codigo(tmp_path):
    (tmp_path / "CLIENTES" / "210-TL ACADEMIA").mkdir(parents=True)
    (tmp_path / "CLIENTES" / "210-OUTRA").mkdir()
    regra = Regra(codigo="CLIENTE_DOCUMENTO", nome="Documento", escopo="mensal",
        caminho_modelo=["{ANO}", "{COMPETENCIA_PASTA}"], padrao_nome="")
    with pytest.raises(ErroCaminho, match="encontrei 2"):
        resolver_pasta_cliente(tmp_path, regra, Contexto(empresa_codigo="210", pasta_clientes="CLIENTES"))
