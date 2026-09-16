"""Conferimento de agendamentos. Execute: python -m streamlit run app.py"""
import csv
import io
import json
from collections import Counter
from dataclasses import asdict, replace
from hashlib import sha256
from pathlib import Path
from time import perf_counter

import streamlit as st

from conferencia import nome_no_banco, fornecedores_proprios
from core import brl, conferir, serializar
from lote import TIPOS_BANCO, conferir_lote, ler_relacoes
from mensagem import mensagem_whatsapp, pendencias_antes_de_enviar

ROOT = Path(__file__).resolve().parent

st.set_page_config(page_title="Conferimento de agendamentos", page_icon="✓", layout="wide")
st.title("Conferimento de agendamentos")
st.caption("Contas a pagar × extrato da folha × agendamentos do banco · sem IA · arquivos originais preservados")

with st.sidebar:
    st.header("Documentos")
    modo = st.radio("Origem dos arquivos", ["Amostras locais", "Enviar PDFs"])
    fontes = []
    if modo == "Amostras locais":
        arquivos = sorted((ROOT / "docs_amostra").glob("*.pdf"))
        grupos = sorted(set(p.name.split("-")[0].strip().upper() for p in arquivos))
        grupo = st.selectbox("Empresa da amostra", grupos) if grupos else None
        fontes = [(p.name, p.read_bytes()) for p in arquivos if p.name.split("-")[0].strip().upper() == grupo]
        for nome, _ in fontes:
            st.caption(nome)
    else:
        uploads = st.file_uploader("Contas a pagar + agendamentos do banco e/ou extrato da folha",
                                   type=["pdf"], accept_multiple_files=True)
        fontes = [(u.name, u.getvalue()) for u in uploads]
    cliente = st.text_input("Cliente no WhatsApp", placeholder="@nome do contato")
    observacoes = st.text_area(
        "Observações (uma por linha)",
        placeholder="A folha de pagamento encontra-se em apuração.\nFornecedor X — boleto ainda não recebido.",
        help="Cada linha vai para a mensagem ao cliente. Se citar a folha em apuração ou um favorecido, "
             "a conferência leva em conta, e o resultado mostra o efeito de cada linha.")
    st.caption("Relações de favorecido já confirmadas, uma por linha: nome no contas a pagar = nome no banco.")
    relacoes_txt = st.text_area("Relações confirmadas", placeholder="Fornecedor Exemplo = Recebedor Exemplo")
    executar = st.button("Conferir", type="primary", width="stretch")

# Alterar qualquer entrada invalida o resultado anterior.
assinatura = sha256(repr(([(n, sha256(b).hexdigest()) for n, b in fontes],
                          cliente, observacoes, relacoes_txt)).encode()).hexdigest()
if st.session_state.get("assinatura") != assinatura:
    st.session_state.pop("resultado", None)

if executar:
    relacoes, invalidas = ler_relacoes(relacoes_txt)
    if invalidas:
        st.error("Relação inválida. Use: nome no contas a pagar = nome no banco, uma por linha.")
    elif not fontes:
        st.error("Selecione os arquivos para começar.")
    else:
        inicio = perf_counter()
        with st.spinner("Lendo os PDFs, validando totais e conferindo..."):
            lote = conferir_lote(fontes, relacoes, observacoes)
            docs, erros, relatorio, detalhes = lote.docs, lote.erros, lote.relatorio, {}
            if relatorio:
                contas = [d for d in docs if d.tipo == "contas"]
                banco = next((d for d in docs if d.tipo in TIPOS_BANCO), None)
                folha = next((d for d in docs if d.tipo == "folha"), None)
                proprios = fornecedores_proprios(contas[0].itens)
                pelo_favorecido = replace(contas[0], itens=[replace(i, nome=nome_no_banco(i, proprios)) for i in contas[0].itens])
                if banco:
                    detalhes["Contas × banco"] = conferir(pelo_favorecido, banco, relacoes, True)
                if folha:
                    pela_pessoa = replace(contas[0], itens=[replace(i, nome=i.descricao) for i in contas[0].itens])
                    detalhes["Contas × folha"] = conferir(pela_pessoa, folha, relacoes)
                if banco and folha:
                    detalhes["Folha × banco"] = conferir(folha, banco, relacoes, True)
            st.session_state.resultado = {"docs": docs, "erros": erros, "relatorio": relatorio,
                                          "comparacoes": detalhes, "segundos": perf_counter() - inicio,
                                          "observacoes": observacoes, "relacoes": relacoes, "cliente": cliente}
            st.session_state.assinatura = assinatura

r = st.session_state.get("resultado")
if not r:
    st.info("Escolha uma empresa da amostra ou envie os PDFs e clique em **Conferir**.")
    st.markdown("A conferência compara o **contas a pagar** com os **agendamentos do banco** e com o "
                "**extrato da folha**: nome, valor, data e situação. O resultado mostra as divergências, "
                "o fechamento dos totais, os pontos para confirmar e o que fazer.")
    st.stop()

cols = st.columns(3)
cols[0].metric("Tempo total", f"{r['segundos']:.2f} s")
cols[1].metric("Páginas lidas", sum(d.paginas for d in r["docs"]))
rel = r["relatorio"]
cols[2].metric("Divergências", len(rel.divergentes) if rel else "—")
for e in r["erros"]:
    st.error(e)
if rel:
    st.success("Leitura e totais validados.")
    if any(not d.cnpj for d in r["docs"]):
        st.warning("Há relatório sem CNPJ no cabeçalho. Confirme que é da mesma empresa; o nome do arquivo não comprova.")

tabs = st.tabs(["Conferência", "Auditoria detalhada", "Dados e evidências", "Exportar"])
with tabs[0]:
    if rel:
        texto = rel.markdown()
        st.markdown(texto)
        st.download_button("Baixar conferência (.md)", texto.encode("utf-8"), "conferencia.md", "text/markdown")
        st.divider()
        st.subheader("Mensagem para o cliente")
        pendencias = pendencias_antes_de_enviar(rel)
        if pendencias:
            st.warning("Antes de enviar, resolva ou explique nas observações:\n\n" + "\n".join(f"- {p}" for p in pendencias))
        st.caption("Copie pelo ícone no canto do quadro.")
        st.code(mensagem_whatsapp(rel, r["cliente"]), language=None)
    else:
        st.info("Corrija os erros acima para ver a conferência.")
with tabs[1]:
    st.caption("Cruzamento par a par, com o motivo de cada associação. Serve para investigar um ponto da conferência.")
    for titulo, rows in r["comparacoes"].items():
        st.subheader(titulo)
        st.dataframe([{"Situação": s, "Quantidade": q} for s, q in Counter(x["status"] for x in rows).items()],
                     hide_index=True, width="stretch")
        situacoes = sorted(set(x["status"] for x in rows))
        filtro = st.multiselect("Situações", situacoes, key=titulo,
                                default=[x for x in situacoes if x not in ["Correspondência", "Líquido zero"]])
        vista = []
        for x in rows:
            if x["status"] not in filtro:
                continue
            y = dict(x)
            for k in ["valor_origem", "valor_destino", "diferença_centavos"]:
                if y.get(k) is not None:
                    y[k] = brl(y[k])
            vista.append(y)
        st.dataframe(vista, hide_index=True, width="stretch")
with tabs[2]:
    st.dataframe([{"Arquivo": d.arquivo, "Layout": d.tipo, "Registros": len(d.itens), "Soma lida": brl(d.total),
                   "Total impresso": brl(d.total_impresso) if d.total_impresso is not None else "Ausente",
                   "Controle": "Validado" if d.integro else "Bloqueado", "Período": " a ".join(d.periodo)}
                  for d in r["docs"]], hide_index=True, width="stretch")
    for d in r["docs"]:
        with st.expander(d.arquivo):
            for a in d.alertas:
                st.error(a)
            st.caption(f"SHA-256: {d.hash}")
            st.dataframe([{"ID": i.id, "Nome": i.nome, "Descrição": i.descricao, "Valor": brl(i.valor), "Data": i.data,
                           "Página": i.pagina, "Situação": i.situacao} for i in d.itens], hide_index=True, width="stretch")
            if d.itens:
                idx = st.selectbox("Registro para ver a evidência", range(len(d.itens)), key=d.hash,
                                   format_func=lambda j, itens=d.itens: f"{itens[j].id} — {itens[j].nome or itens[j].descricao}")
                st.text(d.itens[idx].evidencia)
with tabs[3]:
    payload = {k: v for k, v in r.items() if k not in ("docs", "relatorio")}
    payload.update({"docs": [serializar(d) for d in r["docs"]], "versao": "0.2.0", "valores": "centavos",
                    "conferencia": asdict(rel) if rel else None})
    st.download_button("Baixar resultado completo (JSON)", json.dumps(payload, ensure_ascii=False, indent=2),
                       "conferencia.json", "application/json")
    linhas_csv = [{"comparação": k, **x} for k, rows in r["comparacoes"].items() for x in rows]
    if linhas_csv:
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=list(linhas_csv[0]), delimiter=";")
        writer.writeheader()
        # Evita fórmulas quando o CSV for aberto no Excel.
        writer.writerows({k: ("'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v)
                          for k, v in x.items()} for x in linhas_csv)
        st.download_button("Baixar auditoria (CSV; valores em centavos)", out.getvalue().encode("utf-8-sig"),
                           "auditoria.csv", "text/csv")
    st.caption("Os arquivos baixados contêm dados dos documentos. Nada é gravado no banco do agente.")
