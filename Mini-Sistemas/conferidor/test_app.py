import re
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).parent


@pytest.mark.parametrize("posicao", [0, 1, 2])
def test_interface_amostras(posicao):
    grupos = sorted({p.name.split("-")[0].strip().upper() for p in (ROOT / "docs_amostra").glob("*.pdf")})
    if len(grupos) <= posicao:
        pytest.skip("Sem amostras privadas")
    at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=40).run()
    assert at.title[0].value == "Conferimento de agendamentos"
    at.selectbox[0].select(grupos[posicao]).run()
    at.button[0].click().run()
    assert not at.exception
    assert not at.error
    assert len(at.success) == 1
    assert len(at.tabs) == 4
    assert at.session_state["resultado"]["relatorio"] is not None
    assert any("conferência entre" in m.value or "Tudo confere" in m.value for m in at.markdown)
    # Empresa pelo prefixo do arquivo ("L2H - CONTAS A PAGAR...").
    assert re.fullmatch(r"\*[A-Z0-9]+ \| Contas a pagar de \d\d/\d\d a \d\d/\d\d\*", at.code[0].value.splitlines()[2])
    at.text_area[0].set_value("Novo cenário").run()
    assert "resultado" not in at.session_state


def test_sem_arquivos_mostra_orientacao():
    at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=40).run()
    assert not at.exception
    assert at.title[0].value == "Conferimento de agendamentos"
