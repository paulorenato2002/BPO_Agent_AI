# Importador da base do BPO

Leva para o Supabase o backup do Trello da Effective e as decisões comerciais
(planos, contratos, catálogo e preços), uma etapa por vez.

```bash
python importar_trello.py previa 1    # gera a prévia; não grava nada
python importar_trello.py aplicar 1   # grava exatamente o que a prévia gerou
```

`aplicar` lê o plano salvo pela prévia e confere o banco de novo antes de cada
escrita. Rodar outra vez não duplica nada.

| Etapa | O que grava |
|---|---|
| 1 | Nome fantasia e endereço das empresas |
| 2 | Pessoas e vínculos com as empresas |
| 3 | Grupos de WhatsApp e participantes |
| 4 | Nomes dos planos e contratos |
| 5 | Catálogo de serviços e composição dos planos |
| 6 | Modelos de precificação e regras de valor fixo |
| 7 | Regras de preço por unidade (exige a migration `20260915190000_preco_por_unidade`) |

## Onde ficam os dados

O código só tem a lógica. Tudo que é informação de cliente ou da Effective fica
fora do git, em `Ambiente Effective/infos_e_backup/`:

- os exports do Trello (`*.json`);
- as decisões de cada etapa, em `decisoes/importacao.json` (estrutura em
  [`decisoes.exemplo.json`](decisoes.exemplo.json));
- as prévias geradas, em `previa/`.

O banco é a fonte da verdade. O arquivo de decisões existe para a etapa poder
ser repetida.

## Cuidados

- Parte dos cartões do Trello tem senha no meio do texto. O importador nunca
  imprime o conteúdo original.
- A planilha de precificação é lida direto do XML, porque o openpyxl recusa o
  arquivo. A pasta de origem é somente leitura.
- `servicos.categoria` e `servicos.unidade_cobranca` têm lista fechada no
  banco. Para descobrir um valor aceito, basta tentar: uma inserção recusada
  não grava nada.
