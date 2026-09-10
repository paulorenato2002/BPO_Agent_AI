"""
Varredura das pastas de cliente: do disco para o banco.

POR QUE ISTO EXISTE
-------------------
Para montar o destino de um documento é preciso saber que o cliente 210 mora
na pasta "210-TL ACADEMIA". Quem sabe isso é o disco. Mas a análise roda na
Vercel, onde não existe pasta do OneDrive — lá o `readdir` estoura e nenhum
documento chega a ser arquivado.

Então o lado que TEM o disco varre e publica o mapa; o lado que NÃO tem lê o
mapa do banco. Este módulo é a metade que varre.

O QUE ELE NÃO FAZ
-----------------
Não decide de quem é cada pasta. Manda a lista crua de nomes e o banco casa
com os códigos das empresas. A regra de casamento mora em um lugar só — a
função `sincronizar_pastas_empresas` — porque se ela existisse aqui também,
as duas pontas poderiam divergir sem ninguém perceber.

Não cria, não renomeia e não apaga nada no disco. É leitura pura.
"""
from __future__ import annotations

from pathlib import Path


class ErroMapeamento(Exception):
    """Falha previsível da varredura."""


def listar_containers(regras: dict) -> list[str]:
    """
    Os contêineres de cliente, lidos da estrutura fixa exportada do banco.

    Nada de nome fixo no código: se a empresa renomear "01_CLIENTES_ATIVOS",
    a mudança entra pelo banco e chega aqui pela exportação das regras.
    """
    containers: list[str] = []
    for pasta in regras.get("estrutura_fixa", []):
        if pasta.get("chave") in ("clientes_ativos", "clientes_inativos"):
            modelo = pasta.get("caminho_modelo") or []
            if modelo:
                containers.append(modelo[-1])
    if not containers:
        raise ErroMapeamento(
            "Nenhum contêiner de clientes na estrutura fixa. Regere dados/regras.json "
            "com `npm run exportar:regras`."
        )
    return containers


def varrer_container(raiz: Path, container: str) -> list[str]:
    """
    Nomes das pastas diretamente dentro do contêiner.

    Só o primeiro nível: a pasta do cliente. O que existe dentro dela (ano,
    competência) não é assunto do mapa.
    """
    if "/" in container or "\\" in container or container in ("..", "."):
        raise ErroMapeamento(f"Contêiner inválido: {container!r}")

    pasta = raiz / container
    if not pasta.is_dir():
        raise ErroMapeamento(f"Contêiner não encontrado no disco: {pasta}")

    nomes = []
    for entrada in pasta.iterdir():
        try:
            if not entrada.is_dir():
                continue
        except OSError:
            # Arquivo do OneDrive ainda não baixado pode falhar no stat. Pular
            # é melhor que abortar a varredura inteira por causa de um item.
            continue
        # Pastas de controle do próprio sistema de arquivos não são clientes.
        if entrada.name.startswith(".") or entrada.name.lower() == "desktop.ini":
            continue
        nomes.append(entrada.name)

    return sorted(nomes)


def mapear_uma_vez(api, raiz: Path, regras: dict, identificador_raiz: str) -> list[dict]:
    """
    Varre todos os contêineres e sincroniza cada um com o banco.

    Devolve o relatório por contêiner, como o banco o devolveu. Um contêiner
    que não existe no disco é PULADO com aviso, não apagado do banco: a pasta
    pode estar apenas fora de sincronia no momento, e esvaziar o mapa por isso
    derrubaria o arquivamento de todo mundo.
    """
    relatorios = []
    for container in listar_containers(regras):
        try:
            pastas = varrer_container(raiz, container)
        except ErroMapeamento as e:
            relatorios.append({"container": container, "pulado": str(e)})
            continue

        relatorio = api.rpc(
            "sincronizar_pastas_empresas",
            {"p_raiz": identificador_raiz, "p_container": container, "p_pastas": pastas},
        )
        relatorios.append(relatorio)

    return relatorios


def resumir(relatorios: list[dict]) -> str:
    """Uma linha por contêiner, legível por quem está olhando o terminal."""
    linhas = []
    for r in relatorios:
        if r.get("pulado"):
            linhas.append(f"  {r['container']}: pulado ({r['pulado']})")
            continue
        ambiguas = r.get("ambiguas") or []
        linhas.append(
            f"  {r['container']}: {r['mapeadas']} mapeadas de {r['pastas_lidas']} pastas"
            f" | {r['sem_empresa']} sem empresa"
            f" | {len(ambiguas)} código(s) ambíguo(s)"
            f" | {r['empresas_sem_pasta']} empresa(s) ativa(s) sem pasta"
        )
        for a in ambiguas:
            linhas.append(f"      código {a['codigo']}: {', '.join(a['pastas'])}")
    return "\n".join(linhas)
