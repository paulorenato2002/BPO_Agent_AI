# arquivador_docs

Cataloga, renomeia e arquiva documentos na pasta certa do cliente.

## Por que existe

O plano original era subir os arquivos por API do OneDrive/SharePoint. Isso
depende de alguém do tenant conceder acesso de aplicativo — e essa pessoa não
está disponível. Esperar significaria travar o projeto.

A saída: o OneDrive já sincroniza as pastas na máquina. Então este sistema
**só escreve no disco local**, e quem sobe para a nuvem é o próprio OneDrive.
Zero API, zero OAuth, zero espera.

## O que ele faz

Recebe um arquivo mais o que se sabe sobre ele (empresa, competência, tipo,
regra) e:

1. monta o caminho de destino a partir da regra de arquivamento;
2. monta o nome padronizado;
3. cria as pastas que faltarem;
4. copia o arquivo para lá;
5. registra no diário.

**Não decide de qual empresa é o documento.** Isso é trabalho do agente, que
lê o conteúdo e classifica. Aqui a informação chega pronta.

## Instalação

Precisa de Python 3.11+. Só a biblioteca padrão — `pytest` apenas para testar.

```bash
cd "Mini-Sistemas/arquivador_docs"
cp .env.example .env
```

Depois abra o `.env` e aponte `ARQUIVADOR_RAIZ` para a pasta sincronizada onde
os documentos devem ficar. **Tem que ser uma pasta que o OneDrive sincroniza
nesta máquina** — o sistema só escreve no disco.

## Uso

```bash
# ver as regras disponíveis
python -m arquivador listar-regras
python -m arquivador listar-regras --escopo mensal

# criar as pastas fixas (00_INTERNO, 01_CLIENTES_ATIVOS, 02_CLIENTES_INATIVOS)
python -m arquivador estrutura            # mostra o que faria
python -m arquivador estrutura --aplicar  # cria

# arquivar um documento
python -m arquivador arquivar NF.pdf \
    --regra MENSAL_NOTAS_FISCAIS \
    --empresa ALF --empresa-nome "Panificadora Alfa" \
    --competencia 2026-09 --tipo NOTA_FISCAL

# só mostrar o destino, sem copiar
python -m arquivador arquivar NF.pdf ... --simular

# cliente inativo (vai para 02_CLIENTES_INATIVOS)
python -m arquivador arquivar NF.pdf ... --inativo
```

Arquivar **copia** por padrão: o original fica onde estava. Use `--mover` para
remover a origem depois de confirmar a cópia.

## Modo máquina (agente e n8n)

JSON entra, JSON sai. É por aqui que o agente e o n8n chamam:

```bash
echo '{
  "arquivo": "C:\\caminho\\NF.pdf",
  "regra": "MENSAL_NOTAS_FISCAIS",
  "empresa_codigo": "ALF",
  "empresa_nome": "Panificadora Alfa",
  "empresa_ativa": true,
  "competencia": "2026-09",
  "tipo_documento": "NOTA_FISCAL"
}' | python -m arquivador json --stdin
```

Resposta:

```json
{
  "ok": true,
  "status": "arquivado",
  "caminho_final": "...\\01_CLIENTES_ATIVOS\\ALF\\...\\ALF_PANIFICADORA_ALFA_2026-09_NOTA_FISCAL_v1.pdf",
  "nome_final": "ALF_PANIFICADORA_ALFA_2026-09_NOTA_FISCAL_v1.pdf",
  "versao": 1,
  "sha256": "0e41a771...",
  "erro": null
}
```

Campo faltando devolve o que falta, para o agente saber o que perguntar:

```json
{ "ok": false, "erro": "A regra MENSAL_NOTAS_FISCAIS exige: competencia.",
  "faltando": ["competencia"] }
```

Acrescente `"simular": true` para só calcular o destino sem copiar.

## As travas

O que este sistema **nunca** faz, e por quê:

- **Não sobrescreve.** Se já existe arquivo com o nome e o conteúdo é
  diferente, vira `_v2`, `_v3`. O anterior não é tocado.
- **Não copia duas vezes o mesmo conteúdo.** Se o arquivo que já está lá tem o
  mesmo SHA-256, devolve `ja_existia`. Repetir a operação é seguro.
- **Não escreve fora da raiz.** O destino é conferido depois de resolvido, com
  link simbólico e `..` já expandidos. Nome vindo do documento não escapa.
- **Não deixa arquivo pela metade.** Grava em temporário na mesma pasta e só
  então renomeia — o OneDrive nunca sincroniza um arquivo incompleto com nome
  definitivo.
- **Não quebra no Windows.** Desvia de nome reservado (`CON`, `PRN`, `AUX`…),
  tira ponto e espaço do fim, e avisa antes de estourar o limite de caminho em
  vez de deixar o sistema operacional dar um erro que não explica nada.

## As regras

`dados/regras.json` é **gerado**, não editado à mão. A fonte de verdade é o
banco do Agente BPO. Para atualizar depois de mexer nas regras:

```bash
cd ../.. && npm run exportar:regras
```

Ele é um arquivo à parte de propósito: assim o mini-sistema roda sem
credencial de banco, o que importa quando ele for chamado pelo n8n ou por
outra máquina.

## Testes

```bash
python -m pytest testes/ -q
```

Nenhum teste toca o OneDrive — tudo acontece em pasta temporária.
