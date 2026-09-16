"""
Importa o backup do Trello da Effective para o Supabase, uma etapa por vez.

    python importar_trello.py previa 1    # gera a prévia; não toca no banco
    python importar_trello.py aplicar 1   # grava exatamente o que a prévia gerou

A prévia fica em `infos_e_backup/previa/` (fora do git: contém dados de
clientes). `aplicar` lê o plano salvo pela prévia — o que vai para o banco é o
que foi revisado, não uma nova leitura do Trello — e confere de novo o estado
do banco antes de cada escrita.

Nunca imprime o texto original dos cartões: parte deles tem senha no meio.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

AQUI = Path(__file__).resolve()
RAIZ_PROJETO = AQUI.parents[2]          # Agente BPO
RAIZ_AMBIENTE = AQUI.parents[3]         # Ambiente Effective
BACKUP = RAIZ_AMBIENTE / "infos_e_backup"
PREVIA = BACKUP / "previa"
ARQ_DECISOES = BACKUP / "decisoes" / "importacao.json"


class _Decisoes:
    """Dados de negócio (clientes, contratos, catálogo e preços) ficam fora do git, em ARQ_DECISOES.

    O banco é a fonte da verdade; o arquivo guarda as decisões que alimentaram cada etapa,
    para que ela possa ser repetida. Estrutura em decisoes.exemplo.json.
    """

    _dados: dict | None = None

    def __getitem__(self, chave: str):
        if self._dados is None:
            if not ARQ_DECISOES.exists():
                raise SystemExit(f"Arquivo de decisões não encontrado: {ARQ_DECISOES}\nModelo: decisoes.exemplo.json")
            self._dados = json.loads(ARQ_DECISOES.read_text(encoding="utf-8"))
        return self._dados[chave]


DECISOES = _Decisoes()


# ------------------------------------------------------------------ banco

def _env() -> dict[str, str]:
    valores = {}
    for linha in (RAIZ_PROJETO / ".env").read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", linha)
        if m:
            valores[m.group(1)] = m.group(2)
    return valores


class Banco:
    def __init__(self) -> None:
        env = _env()
        self.url = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/"
        self._chave = env["SUPABASE_SERVICE_ROLE_KEY"]

    def _req(self, metodo: str, caminho: str, corpo=None, prefer: str | None = None):
        cab = {"apikey": self._chave, "Authorization": "Bearer " + self._chave, "Content-Type": "application/json"}
        if prefer:
            cab["Prefer"] = prefer
        dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
        req = urllib.request.Request(self.url + caminho, data=dados, method=metodo, headers=cab)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                texto = r.read().decode("utf-8")
                return json.loads(texto) if texto else None
        except urllib.error.HTTPError as e:
            corpo_erro = e.read().decode('utf-8')
            try:
                msg = json.loads(corpo_erro).get('message') or corpo_erro
            except ValueError:
                msg = corpo_erro
            raise RuntimeError(f"{metodo} {caminho.split('?')[0]} → {e.code}: {msg[:300]}") from None

    def ler(self, tabela: str, **filtros: str) -> list[dict]:
        return self._req("GET", tabela + "?" + urllib.parse.urlencode(filtros))

    def inserir(self, tabela: str, linha: dict) -> dict:
        return self._req("POST", tabela, linha, prefer="return=representation")[0]

    def atualizar(self, tabela: str, id_: str, campos: dict) -> dict:
        return self._req("PATCH", f"{tabela}?id=eq.{id_}", campos, prefer="return=representation")[0]

    def openapi(self) -> dict:
        req = urllib.request.Request(self.url, headers={"apikey": self._chave, "Authorization": "Bearer " + self._chave, "Accept": "application/openapi+json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))


# ------------------------------------------------------------------ Trello

def sem_acento(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def carregar_quadros() -> list[dict]:
    quadros = []
    for arq in sorted(BACKUP.glob("*.json")):
        dados = json.loads(arq.read_text(encoding="utf-8"))
        m = re.match(r"^\s*(\d+)", dados["name"])
        if not m:
            continue
        listas = {l["id"]: l for l in dados["lists"]}
        quadros.append({"codigo": m.group(1), "nome": dados["name"], "dados": dados, "listas": listas})
    return quadros


def cartao_ativo(quadro: dict, nome: str) -> dict | None:
    for c in quadro["dados"]["cards"]:
        lista = quadro["listas"].get(c["idList"], {})
        if not c.get("closed") and not lista.get("closed") and c["name"].strip() == nome:
            return c
    return None


def limpar_markdown(texto: str) -> list[str]:
    texto = (texto or "").replace("\\", "").replace("‌", "")
    return [l.replace("**", "").strip() for l in texto.splitlines() if l.replace("**", "").strip()]


# ------------------------------------------------------------------ etapa 1: empresas

RE_CNPJ = re.compile(r"(?<!\d)(\d{2})\.?(\d{3})\.?(\d{3})/?(\d{4})-?(\d{2})(?!\d)")
RE_CEP = re.compile(r"(?<!\d)(\d{2})\.?(\d{3})-?(\d{3})(?!\d)")

REGIOES_DF = ["asa sul", "asa norte", "park way", "santa maria", "lago sul", "lago norte", "taguatinga",
              "guara", "aguas claras", "sudoeste", "noroeste", "ceilandia", "sobradinho", "gama",
              "samambaia", "recanto das emas", "vicente pires", "jardim botanico", "cruzeiro", "octogonal"]


def ler_cadastrais(desc: str) -> dict:
    """Aceita os dois formatos do Trello: com rótulo (`Razão Social: ...`) e sem (um quadro usa só as linhas soltas)."""
    linhas = limpar_markdown(desc)
    campos: dict[str, str] = {}
    soltas = []
    for l in linhas:
        if ":" in l:
            chave, valor = l.split(":", 1)
            chave = sem_acento(chave).strip()
            campos[chave] = valor.strip()
        else:
            soltas.append(l)

    def campo(*nomes):
        for n in nomes:
            if campos.get(n):
                return campos[n]
        return None

    texto = "\n".join(linhas)
    cnpj = RE_CNPJ.search(texto)
    razao = campo("razao social")
    fantasia = campo("nome fantasia")
    if not razao and soltas:                      # formato sem rótulo
        candidatas = [s for s in soltas if not RE_CNPJ.search(s)]
        razao = candidatas[0] if candidatas else None
        fantasia = fantasia or (candidatas[1] if len(candidatas) > 1 else None)
    return {
        "codigo": re.sub(r"\D", "", campo("codigo da empresa", "cod") or "") or None,
        "razao_social": razao,
        "nome_fantasia": fantasia,
        "cnpj": "".join(cnpj.groups()) if cnpj else None,
        "endereco": campo("endereco"),
        "sistema_financeiro": campo("sistema financeiro utilizado"),
        "plano": campo("plano contratado"),
        "valor_mensal": campo("valor mensal do plano"),
    }


def ler_endereco(texto: str | None) -> dict | None:
    if not texto:
        return None
    avisos = []
    t = texto.upper()
    cep = RE_CEP.search(t)
    if cep:
        t = t.replace(cep.group(0), " ")
    uf = None
    m_uf = re.search(r"(?:^|[\s,\-.])(DF|GO|SP|RJ|MG)(?:\.|\s|$)", t)
    if m_uf:
        uf = m_uf.group(1)
        t = t[: m_uf.start(1)] + " " + t[m_uf.end(1):]
    bairro = None
    for regiao in REGIOES_DF:
        m = re.search(r"\b" + regiao.upper().replace(" ", r"\s+") + r"\b", sem_acento(t).upper())
        if m:
            bairro = regiao.title()
            t = t[: m.start()] + " " + t[m.end():]
            break
    cidade = None
    if re.search(r"\bBRAS[IÍ]LIA\b", t):
        cidade = "Brasília"
        t = re.sub(r"\bBRAS[IÍ]LIA\b", " ", t)
    if cidade and not uf:
        uf = "DF"
        avisos.append("UF deduzida de Brasília")
    if uf == "DF" and not cidade:
        cidade = "Brasília"
        avisos.append("cidade deduzida: região administrativa do DF")
    if not cidade and not uf:
        cidade, uf = "Brasília", "DF"
        avisos.append("sem cidade e UF no Trello — deduzido Brasília/DF pelo padrão do endereço")
    if not cep:
        avisos.append("sem CEP")
    if re.search(r"\bLOJA\s*$", t.strip(" ,.-")):
        avisos.append("número da loja ausente")
    logradouro = re.sub(r"\s+-\s+", " ", t)
    logradouro = re.sub(r"\s*[-,.]\s*(?=[-,.]|$)", "", logradouro)
    logradouro = re.sub(r"\s{2,}", " ", logradouro).strip(" ,.-")
    return {
        "logradouro": logradouro,
        "bairro": bairro,
        "cidade": cidade,
        "uf": uf,
        "cep": "".join(cep.groups()) if cep else None,
        "avisos": avisos,
    }


def previa_1(banco: Banco) -> dict:
    empresas = {e["codigo"]: e for e in banco.ler("empresas", select="id,codigo,razao_social,nome_fantasia,cnpj")}
    enderecos = banco.ler("enderecos_empresa", select="id,empresa_id,tipo_endereco,principal,ativo")
    pais_padrao = (banco.openapi()["definitions"]["enderecos_empresa"]["properties"].get("pais", {}) or {}).get("default")

    plano = {"etapa": 1, "gerado_em": date.today().isoformat(), "empresas": [], "enderecos": [], "alertas": []}
    for q in carregar_quadros():
        if q["codigo"] == DECISOES["codigo_effective"]:
            continue
        emp = empresas.get(q["codigo"])
        card = cartao_ativo(q, "Informações Cadastrais")
        if not emp:
            plano["alertas"].append(f"{q['nome']}: empresa não existe no banco")
            continue
        if not card:
            plano["alertas"].append(f"{q['nome']}: sem cartão Informações Cadastrais")
            continue
        cad = ler_cadastrais(card.get("desc"))

        if cad["cnpj"] and cad["cnpj"] != emp["cnpj"]:
            plano["alertas"].append(f"{q['nome']}: CNPJ do Trello diferente do banco — nada será alterado nesta empresa")
            continue
        if cad["razao_social"] and sem_acento(cad["razao_social"]).strip() != sem_acento(emp["razao_social"] or "").strip():
            plano["alertas"].append(f"{q['nome']}: razão social difere (banco: {emp['razao_social']} · Trello: {cad['razao_social']}) — mantida a do banco")

        mudancas = {}
        if cad["nome_fantasia"] and not emp["nome_fantasia"]:
            mudancas["nome_fantasia"] = cad["nome_fantasia"]
        elif cad["nome_fantasia"] and sem_acento(cad["nome_fantasia"]) != sem_acento(emp["nome_fantasia"]):
            plano["alertas"].append(f"{q['nome']}: nome fantasia difere (banco: {emp['nome_fantasia']} · Trello: {cad['nome_fantasia']}) — mantido o do banco")
        plano["empresas"].append({
            "empresa_id": emp["id"], "codigo": q["codigo"], "nome": emp["nome_fantasia"] or emp["razao_social"],
            "antes": {k: emp[k] for k in mudancas}, "mudancas": mudancas,
        })

        end = ler_endereco(cad["endereco"])
        if not end:
            plano["alertas"].append(f"{q['nome']}: sem endereço no Trello")
            continue
        existente = next((x for x in enderecos if x["empresa_id"] == emp["id"] and x["principal"] and x["ativo"]), None)
        linha = {
            "empresa_id": emp["id"], "tipo_endereco": "estabelecimento", "principal": True,
            "logradouro": end["logradouro"], "bairro": end["bairro"], "cidade": end["cidade"],
            "uf": end["uf"], "cep": end["cep"],
            "observacoes": f"Importado do Trello (cartão Informações Cadastrais) em {date.today().strftime('%d/%m/%Y')}.",
        }
        if not pais_padrao:
            linha["pais"] = "Brasil"
        plano["enderecos"].append({
            "codigo": q["codigo"], "nome": emp["nome_fantasia"] or emp["razao_social"],
            "acao": "atualizar" if existente else "inserir", "endereco_id": existente["id"] if existente else None,
            "linha": linha, "avisos": end["avisos"],
        })
    return plano


def relatorio_1(plano: dict) -> str:
    l = ["# Prévia · Etapa 1 · Empresas", "", f"Gerada em {plano['gerado_em']}. Nada foi gravado.", ""]
    l += ["## Empresas", "", "| Código | Empresa | O que muda |", "|---|---|---|"]
    for e in plano["empresas"]:
        mud = "; ".join(f"{k}: vazio → **{v}**" for k, v in e["mudancas"].items()) or "nada"
        l.append(f"| {e['codigo']} | {e['nome']} | {mud} |")
    l += ["", "## Endereços", "", "| Código | Ação | Logradouro | Bairro | Cidade/UF | CEP | Avisos |", "|---|---|---|---|---|---|---|"]
    for x in plano["enderecos"]:
        r = x["linha"]
        cep = f"{r['cep'][:5]}-{r['cep'][5:]}" if r["cep"] else "—"
        l.append(f"| {x['codigo']} | {x['acao']} | {r['logradouro']} | {r['bairro'] or '—'} | {r['cidade']}/{r['uf']} | {cep} | {'; '.join(x['avisos']) or '—'} |")
    l += ["", "## Alertas", ""] + ([f"- {a}" for a in plano["alertas"]] or ["- nenhum"])
    return "\n".join(l) + "\n"


def aplicar_1(banco: Banco, plano: dict) -> list[str]:
    feitos = []
    for e in plano["empresas"]:
        if not e["mudancas"]:
            continue
        atual = banco.ler("empresas", select="id," + ",".join(e["mudancas"]), id=f"eq.{e['empresa_id']}")[0]
        mudou = [k for k in e["mudancas"] if atual[k] != e["antes"][k]]
        if mudou:
            feitos.append(f"PULADO {e['codigo']}: {', '.join(mudou)} mudou no banco desde a prévia")
            continue
        banco.atualizar("empresas", e["empresa_id"], e["mudancas"])
        feitos.append(f"empresa {e['codigo']}: {', '.join(e['mudancas'])} atualizado")
    for x in plano["enderecos"]:
        if x["acao"] == "atualizar":
            banco.atualizar("enderecos_empresa", x["endereco_id"], x["linha"])
            feitos.append(f"endereço {x['codigo']}: atualizado")
        else:
            ja = banco.ler("enderecos_empresa", select="id", empresa_id=f"eq.{x['linha']['empresa_id']}", principal="eq.true", ativo="eq.true")
            if ja:
                feitos.append(f"PULADO endereço {x['codigo']}: já existe endereço principal (rode a prévia de novo)")
                continue
            banco.inserir("enderecos_empresa", x["linha"])
            feitos.append(f"endereço {x['codigo']}: inserido")
    return feitos


# ------------------------------------------------------------------ etapa 2: pessoas e vínculos


MINUSCULAS = {"da", "de", "do", "das", "dos", "e"}


def nome_proprio(nome: str) -> str:
    partes = nome.strip().split()
    return " ".join(p.lower() if i and p.lower() in MINUSCULAS else p.capitalize() for i, p in enumerate(partes))


def cpf_valido(cpf: str) -> bool:
    if not re.fullmatch(r"\d{11}", cpf) or cpf == cpf[0] * 11:
        return False
    for tam in (9, 10):
        soma = sum(int(cpf[i]) * (tam + 1 - i) for i in range(tam))
        if (soma * 10 % 11) % 10 != int(cpf[tam]):
            return False
    return True


def mascarar_cpf(cpf: str | None) -> str:
    return f"***.***.*{cpf[8]}-{cpf[9:]}" if cpf else "—"


def vinculo_da_funcao(funcao: str) -> str:
    f = sem_acento(funcao or "")
    if "socio" in f:
        return "socio"
    if "administrador" in f:
        return "administrador"
    if "diretor" in f:
        return "diretor"
    if "gerente" in f or "gestor" in f:
        return "gestor"
    if "contador" in f:
        return "contador"
    if f:
        return "funcionario"
    return "outro"


def ler_contatos(desc: str) -> list[dict]:
    """Cada contato começa por uma linha em negrito. Blocos de grupo ficam para a etapa 3."""
    texto = (desc or "").replace("\\", "").replace("‌", "")
    blocos = re.split(r"\n(?=\s*\*\*)", "\n" + texto)
    contatos = []
    for bloco in blocos:
        linhas = [l.strip() for l in bloco.strip().splitlines() if l.strip()]
        if not linhas:
            continue
        nome = linhas[0].replace("*", "").strip().rstrip(":")
        if not nome or sem_acento(nome).startswith("grupo"):
            continue
        campos = {}
        for l in linhas[1:]:
            if ":" in l:
                k, v = l.replace("*", "").split(":", 1)
                campos[sem_acento(k).strip()] = v.strip()
        cpf = re.sub(r"\D", "", campos.get("cpf", "")) or None
        tel = re.sub(r"\D", "", campos.get("telefone", "")) or None
        if tel and tel.startswith("55") and len(tel) in (12, 13):
            tel = tel[2:]
        email = re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", " ".join(linhas))
        contatos.append({
            "nome_trello": nome, "funcao": campos.get("funcao"), "cpf": cpf, "telefone": tel,
            "email": email.group(0).lower() if email else None, "assuntos": campos.get("assuntos relacionados"),
        })
    return contatos


def previa_2(banco: Banco) -> dict:
    empresas = {e["codigo"]: e for e in banco.ler("empresas", select="id,codigo,razao_social,nome_fantasia")}
    pessoas_banco = banco.ler("pessoas", select="id,nome,cpf")
    vinculos_banco = banco.ler("empresa_pessoas", select="id,empresa_id,pessoa_id,ativo")
    hoje = date.today().strftime("%d/%m/%Y")

    plano = {"etapa": 2, "gerado_em": date.today().isoformat(), "pessoas": [], "vinculos": [], "alertas": []}
    chave_pessoa: dict[str, str] = {}   # cpf ou nome normalizado -> ref local

    def ref_pessoa(nome: str, cpf: str | None, tel: str | None, email: str | None) -> str:
        chave = cpf or "nome:" + sem_acento(nome)
        if chave in chave_pessoa:
            return chave_pessoa[chave]
        existente = next((p for p in pessoas_banco if (cpf and p["cpf"] == cpf) or (not cpf and not p["cpf"] and sem_acento(p["nome"]) == sem_acento(nome))), None)
        ref = f"P{len(plano['pessoas']) + 1}"
        plano["pessoas"].append({
            "ref": ref, "acao": "reutilizar" if existente else "inserir", "pessoa_id": existente["id"] if existente else None,
            "linha": {"nome": nome, "cpf": cpf, "telefone_principal": tel, "email_principal": email,
                      "observacoes": f"Importado do Trello (cartão Contatos) em {hoje}."},
        })
        chave_pessoa[chave] = ref
        return ref

    for q in carregar_quadros():
        if q["codigo"] == DECISOES["codigo_effective"]:
            continue
        emp = empresas.get(q["codigo"])
        card = cartao_ativo(q, "Contatos")
        if not emp or not card:
            plano["alertas"].append(f"{q['nome']}: sem empresa no banco ou sem cartão Contatos")
            continue
        socio_visto = False
        for ordem, c in enumerate(ler_contatos(card.get("desc")), start=1):
            corr = DECISOES["correcoes_contato"].get(q["codigo"] + ":" + sem_acento(c["nome_trello"]).split()[0], {})
            nome = corr.get("nome") or nome_proprio(c["nome_trello"])
            cpf = corr["cpf"] if "cpf" in corr else c["cpf"]
            if "cpf" in corr and c["cpf"] and corr["cpf"] is None:
                plano["alertas"].append(f"{q['codigo']} {nome}: CPF do Trello descartado (é o mesmo de outra pessoa)")
            if cpf and not cpf_valido(cpf):
                plano["alertas"].append(f"{q['codigo']} {nome}: CPF inválido no Trello — entra sem CPF")
                cpf = None
            ref = ref_pessoa(nome, cpf, c["telefone"], c["email"])
            tipo = corr.get("tipo_vinculo") or vinculo_da_funcao(c["funcao"])
            cargo = corr.get("cargo") or c["funcao"]
            assuntos = c["assuntos"] or ""
            aprova = tipo == "socio"          # decisão do Paulo: todo sócio aprova
            principal = tipo == "socio" and not socio_visto
            socio_visto = socio_visto or tipo == "socio"
            plano["vinculos"].append({
                "codigo": q["codigo"], "empresa": emp["nome_fantasia"] or emp["razao_social"], "pessoa_ref": ref, "nome": nome,
                "linha": {"empresa_id": emp["id"], "tipo_vinculo": tipo, "cargo": cargo, "descricao_responsabilidades": assuntos or None,
                          "contato_principal": principal, "ordem_contato": ordem, "pode_aprovar": aprova,
                          "observacoes": f"Importado do Trello (cartão Contatos) em {hoje}."},
            })
    for v in plano["vinculos"]:
        p = next(x for x in plano["pessoas"] if x["ref"] == v["pessoa_ref"])
        if p["pessoa_id"] and any(b["empresa_id"] == v["linha"]["empresa_id"] and b["pessoa_id"] == p["pessoa_id"] and b["ativo"] for b in vinculos_banco):
            v["acao"] = "já existe"
        else:
            v["acao"] = "inserir"
    return plano


def relatorio_2(plano: dict) -> str:
    l = ["# Prévia · Etapa 2 · Pessoas e vínculos", "", f"Gerada em {plano['gerado_em']}. Nada foi gravado. CPF mascarado neste arquivo.", ""]
    l += ["## Pessoas", "", "| Ref | Ação | Nome | CPF | Telefone | E-mail |", "|---|---|---|---|---|---|"]
    for p in plano["pessoas"]:
        r = p["linha"]
        l.append(f"| {p['ref']} | {p['acao']} | {r['nome']} | {mascarar_cpf(r['cpf'])} | {'sim' if r['telefone_principal'] else '—'} | {'sim' if r['email_principal'] else '—'} |")
    l += ["", "## Vínculos com as empresas", "", "| Empresa | Pessoa | Ação | Vínculo | Cargo | Principal | Pode aprovar | Responsável por |", "|---|---|---|---|---|---|---|---|"]
    for v in plano["vinculos"]:
        r = v["linha"]
        l.append(f"| {v['codigo']} {v['empresa']} | {v['nome']} | {v['acao']} | {r['tipo_vinculo']} | {r['cargo'] or '—'} | {'sim' if r['contato_principal'] else '—'} | {'sim' if r['pode_aprovar'] else '—'} | {r['descricao_responsabilidades'] or '—'} |")
    l += ["", "## Alertas", ""] + ([f"- {a}" for a in plano["alertas"]] or ["- nenhum"])
    return "\n".join(l) + "\n"


def aplicar_2(banco: Banco, plano: dict) -> list[str]:
    feitos, ids = [], {}
    for p in plano["pessoas"]:
        r = p["linha"]
        if p["acao"] == "reutilizar":
            ids[p["ref"]] = p["pessoa_id"]
            continue
        filtro = {"cpf": f"eq.{r['cpf']}"} if r["cpf"] else {"nome": f"eq.{r['nome']}", "cpf": "is.null"}
        ja = banco.ler("pessoas", select="id", **filtro)
        if ja:
            ids[p["ref"]] = ja[0]["id"]
            feitos.append(f"pessoa {r['nome']}: já existia, reutilizada")
            continue
        ids[p["ref"]] = banco.inserir("pessoas", r)["id"]
        feitos.append(f"pessoa {r['nome']}: inserida")
    for v in plano["vinculos"]:
        if v["acao"] != "inserir":
            continue
        linha = dict(v["linha"], pessoa_id=ids[v["pessoa_ref"]])
        if banco.ler("empresa_pessoas", select="id", empresa_id=f"eq.{linha['empresa_id']}", pessoa_id=f"eq.{linha['pessoa_id']}", ativo="eq.true"):
            feitos.append(f"vínculo {v['codigo']} {v['nome']}: já existia")
            continue
        banco.inserir("empresa_pessoas", linha)
        feitos.append(f"vínculo {v['codigo']} {v['nome']}: inserido ({linha['tipo_vinculo']})")
    return feitos


# ------------------------------------------------------------------ etapa 3: grupos de WhatsApp


def previa_3(banco: Banco) -> dict:
    empresas = {e["codigo"]: e for e in banco.ler("empresas", select="id,codigo,razao_social,nome_fantasia")}
    existentes = banco.ler("grupos_comunicacao", select="id,empresa_id,nome")
    vinculos = banco.ler("empresa_pessoas", select="id,empresa_id,pessoa:pessoas(nome)", ativo="eq.true")
    hoje = date.today().strftime("%d/%m/%Y")
    plano = {"etapa": 3, "gerado_em": date.today().isoformat(), "grupos": [], "alertas": []}
    for g in DECISOES["grupos_whatsapp"]:
        emp = empresas[g["codigo"]]
        ja = next((x for x in existentes if x["empresa_id"] == emp["id"] and sem_acento(x["nome"]) == sem_acento(g["nome"])), None)
        participantes = []
        for cod, nome, papel in g.get("participantes", []):
            v = next((x for x in vinculos if x["empresa_id"] == empresas[cod]["id"] and x["pessoa"] and x["pessoa"]["nome"] == nome), None)
            if not v:
                plano["alertas"].append(f"{g['nome']}: vínculo de {nome} na empresa {cod} não encontrado")
                continue
            participantes.append({"empresa_pessoa_id": v["id"], "nome": nome, "codigo": cod, "papel_no_grupo": papel})
        plano["grupos"].append({
            "codigo": g["codigo"], "empresa": emp["nome_fantasia"] or emp["razao_social"], "acao": "já existe" if ja else "inserir",
            "linha": {"empresa_id": emp["id"], "plataforma": "whatsapp", "nome": g["nome"], "finalidade": g["finalidade"],
                      "principal": g["principal"], "recebe_comunicados": True, "permite_envio_arquivos": True,
                      "usado_para_aprovacoes": False, "ativo": True,
                      "observacoes": (g.get("observacoes", "") + f" Importado em {hoje} (print do WhatsApp + Trello).").strip()},
            "participantes": participantes,
        })
    return plano


def relatorio_3(plano: dict) -> str:
    l = ["# Prévia · Etapa 3 · Grupos de WhatsApp", "", f"Gerada em {plano['gerado_em']}. Nada foi gravado.", "",
         "| Empresa | Grupo | Ação | Principal | Participantes | Finalidade |", "|---|---|---|---|---|---|"]
    for g in plano["grupos"]:
        r = g["linha"]
        part = ", ".join(f"{p['nome']} ({p['codigo']})" for p in g["participantes"]) or "—"
        l.append(f"| {g['codigo']} {g['empresa']} | {r['nome']} | {g['acao']} | {'sim' if r['principal'] else '—'} | {part} | {r['finalidade']} |")
    l += ["", "## Alertas", ""] + ([f"- {a}" for a in plano["alertas"]] or ["- nenhum"])
    return "\n".join(l) + "\n"


def aplicar_3(banco: Banco, plano: dict) -> list[str]:
    feitos = []
    for g in plano["grupos"]:
        r = g["linha"]
        ja = banco.ler("grupos_comunicacao", select="id,nome", empresa_id=f"eq.{r['empresa_id']}")
        atual = next((x for x in ja if sem_acento(x["nome"]) == sem_acento(r["nome"])), None)
        if atual:
            grupo_id = atual["id"]
            feitos.append(f"grupo {r['nome']}: já existia")
        else:
            grupo_id = banco.inserir("grupos_comunicacao", r)["id"]
            feitos.append(f"grupo {r['nome']}: inserido ({g['codigo']})")
        for p in g["participantes"]:
            if banco.ler("grupo_participantes", select="id", grupo_id=f"eq.{grupo_id}", empresa_pessoa_id=f"eq.{p['empresa_pessoa_id']}"):
                continue
            banco.inserir("grupo_participantes", {"grupo_id": grupo_id, "empresa_pessoa_id": p["empresa_pessoa_id"],
                                                  "papel_no_grupo": p["papel_no_grupo"], "administrador_grupo": False,
                                                  "recebe_marcacao": True, "ativo": True})
            feitos.append(f"   participante {p['nome']} (vínculo {p['codigo']}): inserido")
    return feitos


# ------------------------------------------------------------------ etapa 4: planos e contratos


def previa_4(banco: Banco) -> dict:
    empresas = {e["codigo"]: e for e in banco.ler("empresas", select="id,codigo,razao_social,nome_fantasia")}
    planos_banco = banco.ler("planos_referencia", select="id,codigo,nome,nivel,descricao")
    contratos_banco = banco.ler("contratos", select="id,empresa_id,status,ativo")
    hoje = date.today().strftime("%d/%m/%Y")
    plano = {"etapa": 4, "gerado_em": date.today().isoformat(), "planos": [], "contratos": [], "alertas": []}

    for p in DECISOES["planos"]:
        atual = next((x for x in planos_banco if x["codigo"] in (p["codigo_atual"], p["codigo"])), None)
        if not atual:
            plano["alertas"].append(f"plano {p['codigo_atual']} não encontrado no banco")
            continue
        mud = {k: p[k] for k in ("codigo", "nome", "nivel", "descricao") if atual.get(k) != p[k]}
        plano["planos"].append({"id": atual["id"], "antes": {"codigo": atual["codigo"], "nome": atual["nome"]}, "mudancas": mud})

    for c in DECISOES["contratos"]:
        emp = empresas[c["codigo"]]
        ja = [x for x in contratos_banco if x["empresa_id"] == emp["id"] and x["ativo"]]
        plano_id = next(x["id"] for x in plano["planos"] if (x["mudancas"].get("codigo") or x["antes"]["codigo"]) == c["plano"])
        if c.get("estimado"):
            plano["alertas"].append(f"{c['codigo']}: data de início estimada ({c['inicio']}) — confirmar")
        plano["contratos"].append({
            "codigo": c["codigo"], "empresa": emp["nome_fantasia"] or emp["razao_social"], "plano": c["plano"],
            "acao": "já existe contrato ativo" if ja else "inserir",
            "linha": {"empresa_id": emp["id"], "plano_referencia_id": plano_id, "numero_contrato": c["numero"],
                      "descricao": f"BPO Financeiro e Consultoria Financeira — Plano {c['plano'].title()}",
                      "status": "ativo", "data_inicio": c["inicio"], "renovacao_automatica": True,
                      "valor_mensal": c["valor"], "moeda": "BRL", "dia_vencimento": c["dia"], "forma_pagamento": c["forma"],
                      "indice_reajuste": c["reajuste"], "data_proximo_reajuste": c["proximo_reajuste"],
                      "observacoes": c["obs"] + f" Importado em {hoje}.", "ativo": True},
        })
    return plano


def relatorio_4(plano: dict) -> str:
    brl = lambda v: f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    l = ["# Prévia · Etapa 4 · Planos e contratos", "", f"Gerada em {plano['gerado_em']}. Nada foi gravado.", "",
         "## Planos", "", "| Antes | Depois |", "|---|---|"]
    for p in plano["planos"]:
        l.append(f"| {p['antes']['codigo']} · {p['antes']['nome']} | {p['mudancas'].get('codigo', p['antes']['codigo'])} · {p['mudancas'].get('nome', p['antes']['nome'])} |")
    l += ["", "## Contratos", "", "| Empresa | Ação | Plano | Mensalidade | Início | Vencimento | Pagamento | Reajuste |", "|---|---|---|---|---|---|---|---|"]
    for c in plano["contratos"]:
        r = c["linha"]
        ini = "/".join(reversed(r["data_inicio"].split("-")))
        l.append(f"| {c['codigo']} {c['empresa']} | {c['acao']} | {c['plano'].title()} | {brl(r['valor_mensal'])} | {ini} | {('dia ' + str(r['dia_vencimento'])) if r['dia_vencimento'] else '—'} | {r['forma_pagamento'] or '—'} | {r['indice_reajuste'] or '—'} |")
    l += ["", "## Alertas", ""] + ([f"- {a}" for a in plano["alertas"]] or ["- nenhum"])
    return "\n".join(l) + "\n"


def aplicar_4(banco: Banco, plano: dict) -> list[str]:
    feitos = []
    for p in plano["planos"]:
        if p["mudancas"]:
            banco.atualizar("planos_referencia", p["id"], p["mudancas"])
            feitos.append(f"plano {p['antes']['codigo']} → {p['mudancas'].get('codigo', p['antes']['codigo'])}")
    for c in plano["contratos"]:
        r = c["linha"]
        if banco.ler("contratos", select="id", empresa_id=f"eq.{r['empresa_id']}", ativo="eq.true"):
            feitos.append(f"contrato {c['codigo']}: já existia, não alterado")
            continue
        banco.inserir("contratos", r)
        feitos.append(f"contrato {c['codigo']}: inserido ({c['plano'].title()}, {r['valor_mensal']})")
    return feitos


# ------------------------------------------------------------------ etapa 5: catálogo de serviços e composição dos planos


def ler_planilha_xml(caminho: Path) -> dict[str, list[dict[str, str]]]:
    """Leitura direta do XML: o openpyxl recusa este arquivo (nomes definidos quebrados). Só leitura."""
    import html
    import zipfile
    with zipfile.ZipFile(caminho) as z:
        ss = z.read("xl/sharedStrings.xml").decode("utf-8")
        textos = [html.unescape("".join(re.findall(r"<t[^>]*>([^<]*)</t>", si))) for si in re.findall(r"<si>(.*?)</si>", ss, re.S)]
        wb = z.read("xl/workbook.xml").decode("utf-8")
        rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
        alvo = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
        abas = {}
        for nome, rid in re.findall(r'<sheet name="([^"]+)"[^>]*r:id="([^"]+)"', wb):
            xml = z.read("xl/" + alvo[rid].lstrip("/").removeprefix("xl/")).decode("utf-8")
            linhas = []
            for corpo in re.findall(r"<row [^>]*>(.*?)</row>", xml, re.S):
                celulas = {}
                for ref, attrs, miolo in re.findall(r'<c r="([A-Z]+)\d+"([^>]*)>(.*?)</c>', corpo, re.S):
                    v = re.search(r"<v>(.*?)</v>", miolo)
                    if v:
                        celulas[ref] = textos[int(v.group(1))] if 't="s"' in attrs else v.group(1)
                if celulas:
                    linhas.append(celulas)
            abas[html.unescape(nome)] = linhas
    return abas


NIVEL_PLANO = {"BASIC": 1, "PREMIUM": 2, "PLUS": 3}


# `servicos.unidade_cobranca` também tem lista fechada, ainda não mapeada: o aplicar tenta
# os sinônimos em ordem e usa o primeiro que o banco aceitar (falha não grava nada).
UNIDADE_SINONIMOS = {
    "mensal": ["mensal", "mensalidade", "fixo_mensal", "fixo", "mes"],
    "por_unidade": ["por_unidade", "unidade", "por_quantidade", "quantidade", "por_volume", "variavel", "por_transacao", "por_documento"],
}


def _chave_servico(nome: str) -> str:
    return re.sub(r"[^a-z0-9]", "", sem_acento(nome))


def _descricao_requisito(req: str | None) -> str | None:
    if not req or req == "PADRÃO":
        return None
    if req == "SEM PREÇO NA TABELA":
        return "Incluído no plano sem valor próprio na tabela de preço."
    if "VAI TER" in req or "SIM = 1" in req:
        return "Opcional: entra no preço só se contratado."
    if "NOSSA CONTABILIDADE" in req:
        return "Cobrado apenas quando a contabilidade do cliente não é a do grupo."
    return "Preço proporcional a: " + req.rstrip("?").replace("(MÉDIA)", "(média)").lower() + "."


def previa_5(banco: Banco) -> dict:
    planos = {p["codigo"]: p for p in banco.ler("planos_referencia", select="id,codigo,nome")}
    existentes = {s["codigo"]: s for s in banco.ler("servicos", select="id,codigo,nome")}
    hoje = date.today().strftime("%d/%m/%Y")
    plano = {"etapa": 5, "gerado_em": date.today().isoformat(), "servicos": [], "composicao": [], "alertas": []}

    # Conferência contra a planilha: todo nome das abas precisa cair em algum item do catálogo.
    indice = {}
    for item in DECISOES["catalogo_servicos"]:
        for nome in [item["nome"], *item.get("aliases", [])]:
            indice[_chave_servico(nome)] = item["codigo"]
    for nome in DECISOES["servicos_descartados"]:
        indice[_chave_servico(nome)] = "DESCARTADO"
    abas = ler_planilha_xml(Path(DECISOES["planilha_precificacao"]))
    nomes_planilha = {l["B"] for l in abas["LISTA DE SERVIÇOS"][1:] if l.get("B")}
    nomes_planilha |= {l["C"] for l in abas["PLANOS"] if l.get("C") and l.get("A") not in ("Categoria", "DESCRIÇÃO", "Bronze", "Prata", "Ouro")}
    nomes_planilha |= {l["B"] for l in abas["PLANOS"] if l.get("A") in ("Bronze", "Prata", "Ouro") and l.get("B")}
    sem_lugar = sorted(n for n in nomes_planilha if _chave_servico(n) not in indice)
    for n in sem_lugar:
        plano["alertas"].append(f"serviço da planilha sem correspondente no catálogo: {n}")

    # Plano de entrada segundo o quadro de composição (bloco de cima da aba DECISOES["planos"]), para mostrar divergências.
    entrada_quadro = {}
    for l in abas["PLANOS"]:
        if l.get("A") in (None, "Categoria", "DESCRIÇÃO", "Bronze", "Prata", "Ouro") or not l.get("C"):
            continue
        cod = indice.get(_chave_servico(l["C"]))
        if cod == "DESCARTADO":
            continue
        nivel = 1 if l.get("D") else 2 if l.get("E") else 3 if l.get("F") else None
        if cod and nivel:
            entrada_quadro[cod] = min(nivel, entrada_quadro.get(cod, 9))
    for item in DECISOES["catalogo_servicos"]:
        if item.get("plano") and item["codigo"] in entrada_quadro and entrada_quadro[item["codigo"]] != NIVEL_PLANO[item["plano"]] and item["codigo"] != "GES_ANALISE_DRE":
            quadro = {1: "Basic", 2: "Premium", 3: "Plus"}[entrada_quadro[item["codigo"]]]
            plano["alertas"].append(f"{item['nome']}: tabela de preço põe no {item['plano'].title()}, quadro de composição põe no {quadro} — usado {item['plano'].title()}")

    for item in DECISOES["catalogo_servicos"]:
        no_plano = bool(item.get("plano"))
        linha = {
            "codigo": item["codigo"], "nome": item["nome"], "categoria": DECISOES["categoria_servico_no_banco"][item["codigo"]],
            "descricao": item.get("descricao"),
            "unidade_cobranca": ("por_unidade" if item.get("requisito", "PADRÃO").startswith(("QTD", "QUANT")) else "mensal") if no_plano else "por_demanda",
            "recorrente": item.get("recorrente", True), "permite_personalizacao": True, "ativo": True,
            "observacoes": f"Importado da planilha NOVA PRECIFICAÇÃO (jul/2025) em {hoje}." + ("" if no_plano else " Fora dos planos: contratação à parte."),
        }
        plano["servicos"].append({"acao": "já existe" if item["codigo"] in existentes else "inserir", "linha": linha})
        if not no_plano:
            continue
        for cod_plano, nivel in NIVEL_PLANO.items():
            if nivel >= NIVEL_PLANO[item["plano"]]:
                plano["composicao"].append({
                    "plano": cod_plano, "plano_id": planos[cod_plano]["id"], "servico_codigo": item["codigo"],
                    "linha": {"incluido_padrao": True, "frequencia_padrao": item.get("freq"),
                              "descricao_escopo": _descricao_requisito(item.get("requisito")), "ativo": True},
                })
    plano["planos"] = [{"id": planos[c]["id"], "codigo": c, "descricao": d} for c, d in DECISOES["descricao_planos"].items()]
    return plano


def relatorio_5(plano: dict) -> str:
    nomes = {s["linha"]["codigo"]: s["linha"]["nome"] for s in plano["servicos"]}
    l = ["# Prévia · Etapa 5 · Catálogo de serviços e composição dos planos", "", f"Gerada em {plano['gerado_em']}. Nada foi gravado.", "",
         "## Serviços", "", "| Código | Serviço | Categoria | Cobrança | Entra a partir do | Ação |", "|---|---|---|---|---|---|"]
    entrada = {}
    for c in plano["composicao"]:
        entrada.setdefault(c["servico_codigo"], c["plano"])
    for s in plano["servicos"]:
        r = s["linha"]
        l.append(f"| {r['codigo']} | {r['nome']} | {r['categoria']} | {r['unidade_cobranca']} | {entrada.get(r['codigo'], 'fora dos planos').title() if r['codigo'] in entrada else 'fora dos planos'} | {s['acao']} |")
    l += ["", "## Composição", ""]
    for cod in NIVEL_PLANO:
        itens = [c for c in plano["composicao"] if c["plano"] == cod]
        l.append(f"**{cod.title()}** ({len(itens)} serviços): " + "; ".join(nomes[c["servico_codigo"]] for c in itens))
        l.append("")
    l += ["## Alertas", ""] + ([f"- {a}" for a in plano["alertas"]] or ["- nenhum"])
    return "\n".join(l) + "\n"


def aplicar_5(banco: Banco, plano: dict) -> list[str]:
    feitos, ids, aceitas = [], {}, {}
    for p in plano["planos"]:
        banco.atualizar("planos_referencia", p["id"], {"descricao": p["descricao"]})
    feitos.append("descrição dos 3 planos atualizada")
    for s in plano["servicos"]:
        r = s["linha"]
        ja = banco.ler("servicos", select="id", codigo=f"eq.{r['codigo']}")
        if ja:
            ids[r["codigo"]] = ja[0]["id"]
            continue
        tipo = r["unidade_cobranca"]
        candidatos = [aceitas[tipo]] if tipo in aceitas else UNIDADE_SINONIMOS.get(tipo, [tipo])
        for unidade in candidatos:
            try:
                ids[r["codigo"]] = banco.inserir("servicos", dict(r, unidade_cobranca=unidade))["id"]
                aceitas[tipo] = unidade
                break
            except RuntimeError as e:
                if "unidade_cobranca_check" not in str(e):
                    raise
        else:
            feitos.append(f"PARADO em {r['codigo']}: nenhum valor de unidade_cobranca aceito entre {candidatos}")
            return feitos
        feitos.append(f"serviço {r['codigo']}: inserido ({r['categoria']}, {aceitas[tipo]})")
    n = 0
    for c in plano["composicao"]:
        sid = ids[c["servico_codigo"]]
        if banco.ler("plano_servicos", select="id", plano_id=f"eq.{c['plano_id']}", servico_id=f"eq.{sid}"):
            continue
        banco.inserir("plano_servicos", dict(c["linha"], plano_id=c["plano_id"], servico_id=sid))
        n += 1
    feitos.append(f"composição: {n} vínculos plano × serviço inseridos")
    return feitos


# ------------------------------------------------------------------ etapa 6: modelos de precificação e regras de valor fixo


def previa_6(banco: Banco) -> dict:
    servicos = {s["codigo"]: s["id"] for s in banco.ler("servicos", select="id,codigo")}
    existentes_modelos = {m["codigo"]: m["id"] for m in banco.ler("modelos_precificacao", select="id,codigo")}
    existentes_regras = {r["codigo"] for r in banco.ler("regras_precificacao_servicos", select="codigo")}
    hoje = date.today()
    plano = {"etapa": 6, "gerado_em": hoje.isoformat(), "modelos": [], "regras": [], "pendentes": DECISOES["regras_por_unidade"], "alertas": []}
    par = DECISOES["parametros_precificacao"]
    for m in DECISOES["modelos_precificacao"]:
        codigo = f"PREC_{m['plano']}"
        obs = (par["observacao_base"]
               + (f" Gatilho de upgrade: {m['gatilho']}." if m["gatilho"] else "")
               + par["observacao_final"])
        plano["modelos"].append({
            "acao": "já existe" if codigo in existentes_modelos else "inserir",
            "linha": {"codigo": codigo, "nome": f"Precificação {m['plano'].title()}", "versao": par["versao"],
                      "descricao": f"Modelo de preço do plano {m['plano'].title()}.",
                      "margem_lucro_percentual": m["margem"], "aliquota_impostos_percentual": par["aliquota_impostos_percentual"],
                      "desconto_maximo_percentual": par["desconto_maximo_percentual"],
                      "horas_produtivas_mes_padrao": None, "vigencia_inicio": hoje.isoformat(), "status": "ativo",
                      "modelo_padrao": False, "valor_minimo_mensal_padrao": par["valor_minimo_mensal_padrao"], "observacoes": obs, "ativo": True},
        })
        for serv, sufixo, nome, valor, nota in DECISOES["regras_valor_fixo"][m["plano"]]:
            cod_regra = f"{m['plano']}_{serv}{sufixo}"
            plano["regras"].append({
                "acao": "já existe" if cod_regra in existentes_regras else "inserir", "modelo_codigo": codigo, "plano": m["plano"],
                "linha": {"servico_id": servicos[serv], "codigo": cod_regra, "nome_atividade": nome, "metodo_calculo": "valor_fixo_mensal",
                          "valor_fixo_mensal": valor, "quantidade_padrao": 1, "multiplicador_complexidade": 1,
                          "descricao": nota, "observacoes": f"Importado da planilha NOVA PRECIFICAÇÃO em {hoje.strftime('%d/%m/%Y')}.", "ativo": True},
            })
    return plano


def relatorio_6(plano: dict) -> str:
    brl = lambda v: f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    l = ["# Prévia · Etapa 6 · Modelos de precificação e regras de valor fixo", "", f"Gerada em {plano['gerado_em']}. Nada foi gravado.", "",
         "## Modelos", "", "| Código | Margem | Simples | Desconto máx. | Ação |", "|---|---|---|---|---|"]
    for m in plano["modelos"]:
        r = m["linha"]
        l.append(f"| {r['codigo']} | {r['margem_lucro_percentual']}% | {r['aliquota_impostos_percentual']}% | {r['desconto_maximo_percentual']}% | {m['acao']} |")
    for p in NIVEL_PLANO:
        itens = [x for x in plano["regras"] if x["plano"] == p]
        l += ["", f"## Regras de valor fixo · {p.title()} ({len(itens)}, soma {brl(sum(x['linha']['valor_fixo_mensal'] for x in itens))})", "",
              "| Atividade | Valor | Observação |", "|---|---|---|"]
        for x in itens:
            l.append(f"| {x['linha']['nome_atividade']} | {brl(x['linha']['valor_fixo_mensal'])} | {x['linha']['descricao'] or '—'} |")
    l += ["", "## Pendentes: cobrança por volume (fora desta etapa)", ""]
    for p, itens in plano["pendentes"].items():
        l.append(f"- **{p.title()}:** " + "; ".join(f"{brl(v)} por {u}" for _, u, v in itens))
    return "\n".join(l) + "\n"


def aplicar_6(banco: Banco, plano: dict) -> list[str]:
    feitos, ids = [], {}
    for m in plano["modelos"]:
        r = m["linha"]
        ja = banco.ler("modelos_precificacao", select="id", codigo=f"eq.{r['codigo']}")
        ids[r["codigo"]] = ja[0]["id"] if ja else banco.inserir("modelos_precificacao", r)["id"]
        feitos.append(f"modelo {r['codigo']}: {'já existia' if ja else 'inserido'}")
    n = 0
    for x in plano["regras"]:
        r = x["linha"]
        if banco.ler("regras_precificacao_servicos", select="id", codigo=f"eq.{r['codigo']}"):
            continue
        banco.inserir("regras_precificacao_servicos", dict(r, modelo_precificacao_id=ids[x["modelo_codigo"]]))
        n += 1
    feitos.append(f"regras de valor fixo inseridas: {n}")
    return feitos


# ------------------------------------------------------------------ etapa 7: regras de preço por unidade

# Depende da migration 20260915190000_preco_por_unidade.sql (método valor_por_unidade).
def previa_7(banco: Banco) -> dict:
    servicos = {s["codigo"]: s for s in banco.ler("servicos", select="id,codigo,nome")}
    modelos = {m["codigo"]: m["id"] for m in banco.ler("modelos_precificacao", select="id,codigo")}
    existentes = {r["codigo"] for r in banco.ler("regras_precificacao_servicos", select="codigo")}
    hoje = date.today().strftime("%d/%m/%Y")
    plano = {"etapa": 7, "gerado_em": date.today().isoformat(), "regras": [], "alertas": []}
    for cod_plano, itens in DECISOES["regras_por_unidade"].items():
        for serv, unidade, valor in itens:
            cod = f"{cod_plano}_{serv}_UNIDADE"
            plano["regras"].append({
                "plano": cod_plano, "acao": "já existe" if cod in existentes else "inserir",
                "linha": {"modelo_precificacao_id": modelos[f"PREC_{cod_plano}"], "servico_id": servicos[serv]["id"], "codigo": cod,
                          "nome_atividade": f"{servicos[serv]['nome']} — por {unidade}", "metodo_calculo": "valor_por_unidade",
                          "valor_por_unidade": valor, "unidade_medida": unidade, "multiplicador_complexidade": 1,
                          "observacoes": f"Importado da planilha NOVA PRECIFICAÇÃO em {hoje}.", "ativo": True},
            })
    return plano


def relatorio_7(plano: dict) -> str:
    brl = lambda v: f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    l = ["# Prévia · Etapa 7 · Regras de preço por unidade", "", f"Gerada em {plano['gerado_em']}. Nada foi gravado.", "",
         "| Plano | Atividade | Valor | Ação |", "|---|---|---|---|"]
    for x in plano["regras"]:
        r = x["linha"]
        l.append(f"| {x['plano'].title()} | {r['nome_atividade']} | {brl(r['valor_por_unidade'])} | {x['acao']} |")
    return "\n".join(l) + "\n"


def aplicar_7(banco: Banco, plano: dict) -> list[str]:
    n = 0
    for x in plano["regras"]:
        if x["acao"] != "inserir" or banco.ler("regras_precificacao_servicos", select="id", codigo=f"eq.{x['linha']['codigo']}"):
            continue
        banco.inserir("regras_precificacao_servicos", x["linha"])
        n += 1
    return [f"regras por unidade inseridas: {n}"]


# ------------------------------------------------------------------ CLI

ETAPAS = {"1": (previa_1, relatorio_1, aplicar_1), "2": (previa_2, relatorio_2, aplicar_2),
          "3": (previa_3, relatorio_3, aplicar_3), "4": (previa_4, relatorio_4, aplicar_4),
          "5": (previa_5, relatorio_5, aplicar_5), "6": (previa_6, relatorio_6, aplicar_6),
          "7": (previa_7, relatorio_7, aplicar_7)}


def main(argv: list[str]) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(argv) != 3 or argv[1] not in ("previa", "aplicar") or argv[2] not in ETAPAS:
        print(__doc__)
        return 2
    comando, etapa = argv[1], argv[2]
    previa, relatorio, aplicar = ETAPAS[etapa]
    banco = Banco()
    PREVIA.mkdir(parents=True, exist_ok=True)
    arq_plano = PREVIA / f"etapa{etapa}.json"
    arq_md = PREVIA / f"etapa{etapa}.md"

    if comando == "previa":
        plano = previa(banco)
        arq_plano.write_text(json.dumps(plano, ensure_ascii=False, indent=1), encoding="utf-8")
        arq_md.write_text(relatorio(plano), encoding="utf-8")
        print(f"Prévia gerada: {arq_md}")
        return 0

    if not arq_plano.exists():
        print("Gere a prévia antes de aplicar.")
        return 1
    for linha in aplicar(banco, json.loads(arq_plano.read_text(encoding="utf-8"))):
        print(linha)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
