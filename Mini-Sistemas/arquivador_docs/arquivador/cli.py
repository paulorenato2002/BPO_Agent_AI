"""
Linha de comando do arquivador.

Uso típico:

  python -m arquivador listar-regras
  python -m arquivador estrutura --aplicar
  python -m arquivador arquivar NF.pdf --regra MENSAL_NOTAS_FISCAIS \
      --empresa ALF --competencia 2026-09 --tipo NOTA_FISCAL

Arquivar COPIA por padrão: o original fica onde estava. `--mover` remove a
origem depois de confirmar a cópia.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from pathlib import Path

from .api import ErroItem, ErroTransitorio, Supabase

from .arquivar import arquivar, garantir_pasta
from .caminhos import (
    Contexto,
    ErroCaminho,
    Regra,
    montar_destino,
    montar_nome,
    trocar_versao_no_nome,
)
from .config import carregar_config, carregar_regras
from .mapear import ErroMapeamento, listar_containers, mapear_uma_vez, resumir, varrer_container
from .pasta_cliente import resolver_pasta_cliente

# O console do Windows usa cp1252 por padrão: acento sai como "J� EXISTIA" e
# qualquer símbolo fora da tabela DERRUBA o programa com UnicodeEncodeError —
# inclusive na hora de imprimir uma mensagem de erro, que é o pior momento.
for _saida in (sys.stdout, sys.stderr):
    try:
        _saida.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

VERDE = "\033[32m"
VERMELHO = "\033[31m"
AMARELO = "\033[33m"
CINZA = "\033[90m"
NEGRITO = "\033[1m"
FIM = "\033[0m"


def _cor(texto: str, cor: str) -> str:
    return f"{cor}{texto}{FIM}"


def _regras_por_codigo(dados: dict) -> dict[str, Regra]:
    return {r["codigo"]: Regra.de_dict(r) for r in dados["regras"]}


def _container_clientes(dados: dict, ativo: bool) -> str | None:
    """Nome do contêiner de clientes, lido da estrutura fixa exportada."""
    chave = "clientes_ativos" if ativo else "clientes_inativos"
    for pasta in dados.get("estrutura_fixa", []):
        if pasta.get("chave") == chave:
            modelo = pasta.get("caminho_modelo") or []
            return modelo[-1] if modelo else None
    return None


def cmd_listar_regras(args, dados: dict) -> int:
    regras = _regras_por_codigo(dados)
    escopo_filtro = args.escopo

    print()
    for codigo, r in sorted(regras.items(), key=lambda kv: (kv[1].escopo, kv[0])):
        if escopo_filtro and r.escopo != escopo_filtro:
            continue
        exige = []
        if r.exige_empresa:
            exige.append("empresa")
        if r.exige_competencia:
            exige.append("competência")
        if r.exige_instituicao:
            exige.append("instituição")

        print(f"  {_cor(codigo, NEGRITO)}  {_cor(r.escopo, CINZA)}")
        print(f"    {r.nome}")
        print(f"    caminho: {'/'.join(r.caminho_modelo)}")
        if exige:
            print(f"    exige:   {', '.join(exige)}")
        print()

    return 0


def cmd_conferir(args, dados: dict) -> int:
    """
    Inspeciona a raiz ANTES de qualquer coisa ser criada.

    Existe porque apontar a raiz para a pasta errada e só descobrir depois é
    o pior jeito de usar isto. Aqui dá para ver o que já está lá, se a pasta
    é sincronizada e o que seria criado — sem escrever nada.
    """
    config = carregar_config()

    print(f"\n{NEGRITO}Conferindo a raiz{FIM}")
    print(f"  {config.raiz}\n")

    if not config.raiz_existe:
        print(_cor("  x  a pasta não existe", VERMELHO))
        print("     Crie a pasta ou corrija ARQUIVADOR_RAIZ no .env.\n")
        return 1
    print(f"  {_cor('OK', VERDE)}   a pasta existe")

    # Escrita: testa de verdade, com um arquivo que some em seguida. Descobrir
    # que a pasta é somente leitura no meio de um arquivamento é tarde demais.
    try:
        teste = config.raiz / ".teste_de_escrita_arquivador"
        teste.write_text("ok", encoding="utf-8")
        teste.unlink()
        print(f"  {_cor('OK', VERDE)}   dá para escrever")
    except OSError as e:
        print(_cor(f"  x  não dá para escrever: {e}", VERMELHO))
        return 1

    # Se a pasta não for sincronizada, os arquivos ficam só nesta máquina —
    # o propósito inteiro cai por terra, e sem nenhum erro visível.
    texto = str(config.raiz).lower()
    if "onedrive" in texto or "sharepoint" in texto or "- me" in texto:
        print(f"  {_cor('OK', VERDE)}   parece pasta sincronizada")
    else:
        print(_cor("  !  o caminho não parece sincronizado", AMARELO))
        print("     Se não for, os arquivos ficam só nesta máquina.")

    conteudo = sorted(p.name for p in config.raiz.iterdir() if not p.name.startswith("."))
    fixas = {"/".join(f["caminho_modelo"]) for f in dados.get("estrutura_fixa", [])}
    topos = {c.split("/")[0] for c in fixas}
    estranhos = [c for c in conteudo if c not in topos and c != "desktop.ini"]

    print(f"\n{NEGRITO}O que já está na raiz{FIM}")
    if not conteudo:
        print(f"  {_cor('(vazia)', CINZA)}")
    else:
        for nome in conteudo[:20]:
            marca = _cor("nossa", VERDE) if nome in topos else _cor("já existia", AMARELO)
            print(f"  {marca} {nome}")
        if len(conteudo) > 20:
            print(f"  {_cor('... e mais ' + str(len(conteudo) - 20), CINZA)}")

    if estranhos:
        print(_cor(f"\n  !  {len(estranhos)} item(ns) que não são do arquivador.", AMARELO))
        print("     Nada será apagado nem sobrescrito, mas confira se a raiz é essa mesmo.")

    faltando = [c for c in sorted(fixas) if not (config.raiz / c).is_dir()]
    print(f"\n{NEGRITO}Estrutura fixa{FIM}")
    if faltando:
        print(f"  {len(faltando)} de {len(fixas)} pastas ainda não existem:")
        for c in faltando:
            print(f"    {_cor('criaria', AMARELO)} {c}")
        print(f"\n  Para criar: {NEGRITO}python -m arquivador estrutura --aplicar{FIM}")
    else:
        print(f"  {_cor('OK', VERDE)}   as {len(fixas)} pastas já existem")

    print()
    return 0


def cmd_estrutura(args, dados: dict) -> int:
    """Cria as pastas fixas dentro da raiz configurada."""
    config = carregar_config()

    print(f"\n{NEGRITO}Estrutura fixa{FIM}")
    print(f"  raiz: {config.raiz}\n")

    if not config.raiz_existe:
        print(_cor(f"  A raiz não existe: {config.raiz}", VERMELHO))
        print("  Confira ARQUIVADOR_RAIZ no .env.\n")
        return 1

    fixas = dados.get("estrutura_fixa", [])
    if not fixas:
        print(_cor("  Nenhuma pasta fixa no arquivo de regras.", VERMELHO))
        return 1

    criadas = 0
    existiam = 0

    for pasta in fixas:
        segmentos = list(pasta["caminho_modelo"])
        caminho = config.raiz.joinpath(*segmentos)
        ja_existia = caminho.is_dir()

        if not args.aplicar:
            marca = _cor("existe", CINZA) if ja_existia else _cor("criaria", AMARELO)
            print(f"  {marca} {'/'.join(segmentos)}")
            continue

        garantir_pasta(config.raiz, segmentos)
        if ja_existia:
            existiam += 1
            print(f"  {_cor('existe', CINZA)} {'/'.join(segmentos)}")
        else:
            criadas += 1
            print(f"  {_cor('CRIADA', VERDE)} {'/'.join(segmentos)}")

    if not args.aplicar:
        print(f"\n  {_cor('SIMULACAO', AMARELO)} nada foi criado.")
        print(f"  Para criar: {NEGRITO}python -m arquivador estrutura --aplicar{FIM}\n")
        return 0

    print(f"\n  criadas: {criadas} | já existiam: {existiam}\n")
    return 0


def cmd_mapear(args, dados: dict) -> int:
    """
    Publica no banco o nome real da pasta de cada cliente.

    Sem isso a análise na Vercel não monta destino nenhum: ela não enxerga o
    disco. `--simular` mostra o que seria enviado e NÃO precisa de credencial —
    serve para conferir a varredura antes de ligar o banco.
    """
    config = carregar_config()

    print(f"\n{NEGRITO}Mapa de pastas de cliente{FIM}")
    print(f"  raiz: {config.raiz}\n")

    if not config.raiz_existe:
        print(_cor(f"  A raiz não existe: {config.raiz}", VERMELHO))
        return 1

    try:
        containers = listar_containers(dados)
    except ErroMapeamento as e:
        print(_cor(f"  {e}", VERMELHO))
        return 1

    if args.simular:
        for container in containers:
            try:
                pastas = varrer_container(config.raiz, container)
            except ErroMapeamento as e:
                print(_cor(f"  {container}: {e}", AMARELO))
                continue
            print(f"  {_cor(container, NEGRITO)}: {len(pastas)} pasta(s)")
            for nome in pastas[:20]:
                print(f"    {nome}")
            if len(pastas) > 20:
                print(f"    {_cor('... e mais ' + str(len(pastas) - 20), CINZA)}")
        print(f"\n  {_cor('SIMULACAO', AMARELO)} nada foi enviado ao banco.\n")
        return 0

    api = Supabase(
        os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    )
    identificador = os.environ.get("ARQUIVADOR_WORKER_ID", socket.gethostname())

    try:
        relatorios = mapear_uma_vez(api, config.raiz, dados, identificador)
    except (ErroTransitorio, ErroItem) as e:
        print(_cor(f"\n  {e}\n", VERMELHO))
        return 1

    print(resumir(relatorios))
    print(f"\n  {_cor('MAPA ATUALIZADO', VERDE)} raiz: {identificador}\n")
    return 0


def cmd_arquivar(args, dados: dict) -> int:
    config = carregar_config()
    regras = _regras_por_codigo(dados)

    regra = regras.get(args.regra)
    if not regra:
        print(_cor(f"\n✗ Regra desconhecida: {args.regra}", VERMELHO))
        print("  Veja as disponíveis com: python -m arquivador listar-regras\n")
        return 1

    origem = Path(args.arquivo).expanduser()
    if not origem.is_file():
        print(_cor(f"\n✗ Arquivo não encontrado: {origem}\n", VERMELHO))
        return 1

    container = _container_clientes(dados, ativo=not args.inativo)

    ctx = Contexto(
        empresa_codigo=args.empresa,
        empresa_nome=args.empresa_nome or args.empresa,
        pasta_clientes=container,
        competencia=args.competencia,
        instituicao=args.instituicao,
        tipo_documento=args.tipo,
        data_documento=args.data,
        projeto=args.projeto,
        extensao=origem.suffix.lstrip("."),
    )

    try:
        resolver_pasta_cliente(config.raiz, regra, ctx)
        destino = montar_destino(regra, ctx)
        nome = montar_nome(regra, ctx)
    except ErroCaminho as e:
        print(_cor(f"\n✗ {e}", VERMELHO))
        if e.faltando:
            print(f"  Faltando: {', '.join(e.faltando)}\n")
        return 1

    print(f"\n{NEGRITO}Arquivamento{FIM}")
    print(f"  origem:  {origem}")
    print(f"  destino: {destino.caminho_relativo}/{nome}")
    print(f"  raiz:    {config.raiz}")

    if args.simular:
        print(f"\n  {_cor('SIMULACAO', AMARELO)} nada foi copiado.\n")
        return 0

    resultado = arquivar(
        origem=origem,
        raiz=config.raiz,
        segmentos=destino.segmentos,
        nome_final=nome,
        trocar_versao=trocar_versao_no_nome,
        diario=config.diario,
        mover=args.mover,
    )

    if resultado.status == "erro":
        print(_cor(f"\n✗ {resultado.erro}\n", VERMELHO))
        return 1

    if resultado.status == "ja_existia":
        print(f"\n  {_cor('JÁ EXISTIA', CINZA)} mesmo conteúdo, nada foi copiado")
        print(f"  {resultado.caminho_final}\n")
        return 0

    print(f"\n  {_cor('ARQUIVADO', VERDE)} v{resultado.versao}")
    print(f"  {resultado.caminho_final}")
    print(f"  sha256: {resultado.sha256[:16]}…\n")
    return 0


def cmd_json(args, dados: dict) -> int:
    """
    Modo máquina: recebe um JSON e devolve um JSON.

    É por aqui que o agente e o n8n vão falar com o arquivador, sem depender
    de parsear texto colorido.
    """
    bruto = sys.stdin.read() if args.stdin else args.payload
    try:
        entrada = json.loads(bruto)
    except json.JSONDecodeError as e:
        # Interface de máquina responde em JSON até quando a entrada é lixo —
        # quem chama (n8n, agente) não sabe ler stack trace.
        print(json.dumps({"ok": False, "erro": f"JSON inválido: {e}"}, ensure_ascii=False))
        return 1

    if not isinstance(entrada, dict):
        print(json.dumps({"ok": False, "erro": "O JSON precisa ser um objeto."}))
        return 1

    if not entrada.get("arquivo"):
        print(json.dumps({"ok": False, "erro": "Campo 'arquivo' é obrigatório."}, ensure_ascii=False))
        return 1

    config = carregar_config()
    regras = _regras_por_codigo(dados)
    regra = regras.get(entrada.get("regra", ""))

    if not regra:
        print(json.dumps({"ok": False, "erro": f"Regra desconhecida: {entrada.get('regra')}"}))
        return 1

    ativo = bool(entrada.get("empresa_ativa", True))
    ctx = Contexto(
        empresa_codigo=entrada.get("empresa_codigo"),
        empresa_nome=entrada.get("empresa_nome") or entrada.get("empresa_codigo"),
        pasta_clientes=_container_clientes(dados, ativo=ativo),
        competencia=entrada.get("competencia"),
        instituicao=entrada.get("instituicao"),
        tipo_documento=entrada.get("tipo_documento"),
        data_documento=entrada.get("data_documento"),
        projeto=entrada.get("projeto"),
        extensao=Path(entrada.get("arquivo", "")).suffix.lstrip("."),
    )

    try:
        resolver_pasta_cliente(config.raiz, regra, ctx)
        destino = montar_destino(regra, ctx)
        nome = montar_nome(regra, ctx)
    except ErroCaminho as e:
        print(json.dumps({"ok": False, "erro": str(e), "faltando": e.faltando}, ensure_ascii=False))
        return 1

    if entrada.get("caminho_confirmado") and entrada["caminho_confirmado"] != f"{destino.caminho_relativo}/{nome}":
        print(json.dumps({"ok": False, "erro": "O destino mudou desde a proposta. Refaça a análise antes de arquivar."}, ensure_ascii=False))
        return 1

    if entrada.get("simular"):
        print(
            json.dumps(
                {
                    "ok": True,
                    "simulado": True,
                    "caminho_relativo": f"{destino.caminho_relativo}/{nome}",
                    "nome_final": nome,
                },
                ensure_ascii=False,
            )
        )
        return 0

    resultado = arquivar(
        origem=Path(entrada["arquivo"]).expanduser(),
        raiz=config.raiz,
        segmentos=destino.segmentos,
        nome_final=nome,
        trocar_versao=trocar_versao_no_nome,
        diario=config.diario,
        mover=bool(entrada.get("mover")),
    )

    corpo = {
        "ok": resultado.status != "erro",
        "status": resultado.status,
        "caminho_final": resultado.caminho_final,
        # Caminho da PASTA relativo à raiz. Quem chama (o agente) precisa
        # registrar isso no banco, e a raiz é configuração de máquina: se o
        # caminho absoluto fosse gravado, mudar de computador quebraria o
        # histórico inteiro.
        "caminho_relativo": destino.caminho_relativo,
        "nome_final": resultado.nome_final,
        "versao": resultado.versao,
        "sha256": resultado.sha256,
        "erro": resultado.erro,
    }
    print(json.dumps(corpo, ensure_ascii=False))
    return 0 if corpo["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="arquivador",
        description="Cataloga e arquiva documentos na pasta sincronizada do OneDrive.",
    )
    sub = p.add_subparsers(dest="comando", required=True)

    pl = sub.add_parser("listar-regras", help="mostra as regras disponíveis")
    pl.add_argument("--escopo", choices=["interno", "fixo", "mensal", "projeto"])
    pl.set_defaults(func=cmd_listar_regras)

    pc = sub.add_parser("conferir", help="inspeciona a raiz sem escrever nada")
    pc.set_defaults(func=cmd_conferir)

    pe = sub.add_parser("estrutura", help="cria as pastas fixas na raiz")
    pe.add_argument("--aplicar", action="store_true", help="cria de verdade")
    pe.set_defaults(func=cmd_estrutura)

    pm = sub.add_parser("mapear", help="publica no banco o nome real da pasta de cada cliente")
    pm.add_argument("--simular", action="store_true", help="mostra a varredura sem enviar (dispensa credencial)")
    pm.set_defaults(func=cmd_mapear)

    pa = sub.add_parser("arquivar", help="arquiva um documento")
    pa.add_argument("arquivo")
    pa.add_argument("--regra", required=True)
    pa.add_argument("--empresa", help="código curto da empresa (ex.: ALF)")
    pa.add_argument("--empresa-nome", dest="empresa_nome")
    pa.add_argument("--competencia", help="AAAA-MM")
    pa.add_argument("--tipo", help="tipo do documento (ex.: NOTA_FISCAL)")
    pa.add_argument("--instituicao")
    pa.add_argument("--data", help="data do documento, AAAA-MM-DD")
    pa.add_argument("--projeto")
    pa.add_argument("--inativo", action="store_true", help="cliente inativo")
    pa.add_argument("--mover", action="store_true", help="remove a origem após copiar")
    pa.add_argument("--simular", action="store_true", help="só mostra o destino")
    pa.set_defaults(func=cmd_arquivar)

    pj = sub.add_parser("json", help="modo máquina: JSON entra, JSON sai")
    pj.add_argument("--payload", default="{}")
    pj.add_argument("--stdin", action="store_true", help="lê o JSON da entrada padrão")
    pj.set_defaults(func=cmd_json)

    args = p.parse_args(argv)

    config = carregar_config()
    dados = carregar_regras(config.regras)

    return args.func(args, dados)


if __name__ == "__main__":
    raise SystemExit(main())
