# Chat na Vercel, arquivador no PC

O chat recebe o documento e extrai o texto em TypeScript. O agente **analisa e
propõe**, mostra a lista — nome original, nome novo, empresa e competência — e
espera você aprovar. Qualquer resposta afirmativa serve ("sim", "ok",
"simbora"); dúvida ou pedido de mudança não. Só depois disso o pedido é
registrado no Supabase. O Python no PC
consulta a fila a cada 2 segundos, baixa o original do Storage, confere SHA-256
e tamanho, calcula o destino pelas mesmas regras e copia para a pasta local.
O OneDrive faz a sincronização. A confirmação no chat significa **cópia local
concluída**, não confirmação de que o OneDrive terminou de subir para a nuvem.

O Python não interpreta o documento: empresa, competência e tipo chegam da
proposta confirmada. Ele lê os bytes, verifica integridade, renomeia e copia.
Não há n8n no percurso e o worker não chama APIs de IA. O chat e a classificação
continuam usando a API OpenAI configurada no projeto; esses usos têm cobrança.
O polling e os avisos de status não usam IA.

## Primeiro: teste demonstrativo sem API e sem clientes reais

No PowerShell, a partir da raiz do projeto:

```powershell
Set-Location 'Mini-Sistemas/arquivador_docs'
python -m arquivador.demonstracao
```

Esse comando **não lê o `.env`**. Ele cria uma pasta nova no temporário do Windows
e imprime `pasta_para_conferir`. Abra essa pasta no Explorer e confira:

- `destino/`: contém a versão 1 e a versão 2 de um TXT fictício;
- `documento_teste.txt`: original preservado;
- `diario.jsonl`: operações realizadas;
- resultado `ok: true`: primeira cópia, repetição sem duplicar, nova versão e
  retomada da versão 2 foram verificadas.

Não apaga as pastas de demonstração: elas ficam disponíveis para sua inspeção.

Suíte completa, também sem rede:

```powershell
python -m pytest testes/ -q -p no:cacheprovider
```

## O mapa de pastas: por que a Vercel depende dele

Para montar o destino é preciso saber que o cliente 210 mora na pasta
`210-TL ACADEMIA`. Quem sabe isso é o disco — e na Vercel não existe disco do
OneDrive. Antes, a análise fazia `readdir` na pasta sincronizada; publicado,
isso não erra o destino, apenas **para**: todo item vira "pasta do cliente não
encontrada" e nada é arquivado.

A inversão: quem tem o disco varre e publica; quem não tem lê o banco.

```powershell
# ver o que seria enviado, sem credencial e sem gravar nada
python -m arquivador mapear --simular

# publicar o mapa (precisa de SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY)
python -m arquivador mapear
```

O mapeador é um **processo próprio**, e faz uma coisa só:

```powershell
python -m arquivador.mapeador              # varre a cada 30s
python -m arquivador.mapeador --uma-vez    # varre uma vez e sai
```

Ele saiu de dentro do worker de propósito. Amarrado ao worker, o mapa parava de
ser atualizado enquanto um arquivo grande era copiado, e não dava para manter o
mapa fresco sem deixar o worker aberto. Separados, cada um é reiniciado e
diagnosticado sozinho. Só imprime quando algo muda.

O Python manda só a lista de nomes de pasta. Quem decide de quem é cada uma é a
função `sincronizar_pastas_empresas`, no banco — a regra mora em um lugar só,
senão as duas pontas divergiriam em silêncio. A regra: a pasta começa com o
código e o que vem logo depois é fim, espaço ou traço. Assim `210` casa com
`210-TL ACADEMIA`, `210 - TL ACADEMIA` e `210 TL ACADEMIA`, e **nunca** com
`2100-OUTRA`.

Ambiguidade não vira escolha. Dois clientes disputando o código, ou dois
diretórios para o mesmo código (acontece: `233- LP COMERCIO` e
`233- POLAR BRASILIA`), e **nenhum** é mapeado — o caso volta para o humano em
vez de arquivar na pasta de outro cliente. As pastas recusadas ficam em
`pastas_sem_empresa` para o painel poder mostrar o que precisa de cadastro.

Cada varredura manda o contêiner inteiro, então pasta renomeada é acompanhada e
pasta apagada sai do mapa. Se o contêiner não existir no disco no momento da
varredura, ele é **pulado** com aviso em vez de esvaziado: uma pasta fora de
sincronia não pode derrubar o arquivamento de todo mundo.

Quando mais de uma máquina publica mapa, defina `ARQUIVADOR_RAIZ_ID` no
ambiente do chat com o mesmo valor do `ARQUIVADOR_WORKER_ID` daquele PC.

Asserções: `npm run test:mapa` (em memória, sem rede) e `npm run test:migrations`
(Postgres em Docker, mostra asserção por asserção).

## Painel de arquivamento em lote

`/painel` é a tela para quando os documentos chegam em monte. Sobe vários
arquivos, mostra uma linha por documento com empresa, competência, tipo,
instituição e o destino calculado, deixa corrigir o que ficou ambíguo e
confirma de uma vez.

Ela não reimplementa nada: chama o mesmo `analisarDocumentos` e a mesma RPC
`enfileirar_arquivamento` que o chat usa. Duas implementações da mesma decisão
acabariam mandando o mesmo documento para lugares diferentes.

Só é selecionável a linha que tem destino calculado, e o botão diz quantos
arquivos vai mexer. Não existe "arquivar tudo" que passe por cima de um item
ambíguo.

O agente conhece a ferramenta `link_painel_arquivamento` e manda o endereço
quando o usuário aparece com um lote grande. Para um ou dois arquivos ele
continua resolvendo na conversa, que é mais rápido.

## Ativar a fila

1. Aplicar, após as migrations anteriores, o arquivo
   `supabase/migrations/20260908130800_fila_arquivamento_local.sql` no projeto
   Supabase usado pelo chat. O baseline de testes **não** deve ser aplicado nele.
2. Na Vercel, configurar `ARQUIVAMENTO_DESTINO=fila` e publicar a versão com
   a fila. O padrão quando a variável não existe também é `fila`.
3. No PC, preencher `Mini-Sistemas/arquivador_docs/.env`, usando o exemplo
   dessa pasta. São necessários `ARQUIVADOR_RAIZ`, `SUPABASE_URL` e
   `SUPABASE_SERVICE_ROLE_KEY`. A raiz deve existir e ser sincronizada pelo
   OneDrive. Não copie esses segredos para o código ou para o chat.
4. Manter `ARQUIVADOR_WORKER_ID` estável; ao reiniciar ele retoma o pedido que
   estava processando. Esta versão é para **um PC responsável**.
5. Na pasta do mini-sistema, iniciar:

```powershell
python -m arquivador.worker
```

Deixe o terminal aberto. `Ctrl+C` encerra o worker; a fila continua no banco.
O PC precisa estar ligado, conectado e com acesso à pasta. Se estiver desligado,
os pedidos aguardam. Não é necessário abrir porta de entrada no PC: ele consulta
o Supabase por HTTPS.

Para processar no máximo um pedido **real** já confirmado e terminar:

```powershell
python -m arquivador.worker --uma-vez
```

`--uma-vez` não é simulação. Para teste isolado use `arquivador.demonstracao`.

## Comportamento e recuperação

- O chat diferencia aguardando, processando, concluído e erro. O status é
  atualizado sem nova chamada ao modelo, e a conclusão também vira mensagem
  persistida na conversa.
- Arquivos grandes recebem aviso de demora. Não há timeout total por arquivo.
  Há timeout de conexão parada; em caso de queda de rede o worker tenta novamente.
- Se a cópia já terminou e só falta registrar, repete somente a confirmação.
  Após reiniciar o processo, o hash nas versões já copiadas evita duplicação.
- Erro real de disco, hash alterado, empresa não confirmada ou destino diferente
  da proposta ficam visíveis no chat. Corrija a causa e solicite nova análise e
  confirmação. Não marque uma linha como concluída manualmente.
- A regra é fotografada na confirmação, e o caminho recalculado pelo Python
  precisa coincidir com o apresentado. No teste local, `ARQUIVADOR_ESTRUTURA=existente`
  adapta as regras de cliente para a pasta existente `<código>-<nome>/ANO/MM.AAAA`,
  sem categorias adicionais. Configure essa variável no `.env.local` do chat e
  no `.env` do Python. O nome é localizado pelo prefixo do código, nunca inferido
  pela razão social. Pasta ausente ou código duplicado exige correção. O catálogo
  global do Supabase não é alterado por essa configuração local.
- `ARQUIVAMENTO_DESTINO=local` mantém o modo antigo em que Next e Python rodam
  juntos no mesmo PC. `google_drive` mantém o adaptador de API existente.

## Limites desta etapa

Foi implementada a fila de **arquivamento**, não uma reescrita da extração.
O upload continua passando pelo Next e conserva seus limites: teto de 20 MB no
código e limite de corpo da hospedagem. O aviso de demora não aumenta esses
limites. Upload direto/resumível no Storage e extração assíncrona são uma etapa
separada necessária para anexos que excedam o limite de requisição da Vercel.

A desambiguação de siglas como TL retorna opções, e empresa apenas provável
exige confirmação explícita antes de arquivar. Memória de padrões reutilizáveis
não foi ativada nesta entrega; nenhuma sugestão vira regra permanente sozinha.

## Validar o SQL sem banco real

Na raiz do projeto, com Node instalado:

```powershell
npm install --prefix .teste-sql-runtime --no-save --package-lock=false @electric-sql/pglite
node scripts/testar-fila-local.mjs
```

O teste usa Postgres em memória, aplica as migrations sobre um baseline fictício
e verifica propriedade, empresa provável, repetição, claim, retomada e conclusão
atômica. Não lê credenciais. A extensão `pgcrypto` é omitida nesse runtime; o
gerador UUID nativo atende os testes. Para testar também o ambiente Postgres
completo, existe `npm run test:migrations`, que requer Docker em execução.


## Formatos que a extração lê

`pdf`, `xlsx`, `xls`, `csv`, `txt` e `ofx`.

O **OFX** não é lido inteiro. Um extrato mensal tem centenas de lançamentos e o
classificador não precisa de nenhum deles para saber que aquilo é um extrato de
conta corrente do Sicoob de agosto. Sai o cabeçalho — banco, agência, conta,
período, saldo — mais uma amostra de 40 lançamentos e a contagem total. Um
arquivo de 108 KB vira 2 KB de texto útil.

As datas dos lançamentos saem **sem separador** (`20260815`). No formato
`2026-08-15` cada lançamento viraria um candidato a competência, e um extrato com
movimento em dois meses seria marcado como ambíguo. O período do extrato é
declarado uma vez, com separador, e é ele que vale.

**Planilha de portal não começa na linha 1.** Relatórios de banco e adquirente
abrem com um bloco decorativo: logo, telefone da ouvidoria, quem exportou. A
extração procura a linha que parece cabeçalho — muitas células, todas curtas,
sem quebra de linha — e ignora título mesclado. No export de recebíveis da Cielo
isso é a diferença entre ler 4 "colunas" de texto institucional e as 59 colunas
reais.

## Segredo no documento: tarja, não recusa

Havia um só tratamento: casou com padrão de segredo, recusa o arquivo. Isso
reprovou um extrato financeiro real por causa de uma linha na coluna
"Observações" que dizia `SENHA : 50936` — a senha do boleto.

Agora são dois grupos:

- **Estrutural** (`-----BEGIN ... PRIVATE KEY`, `AKIA…`, `sk-…`, Bearer): o
  arquivo É uma credencial. Continua recusado.
- **Léxico** (`senha:`, `token:`, `secret:`): o valor é **tarjado** e o
  documento segue. O rótulo fica — ajuda a classificar — e o valor nunca chega
  ao modelo.

Tarjar é mais seguro que recusar. Recusar não tira o segredo de lugar nenhum;
só faz a pessoa perder o documento e procurar outro caminho para arquivá-lo.

## Confirmação: o fluxo agora sempre passa por você

O agente **propõe e espera**. Para cada arquivo ele mostra:

```
nome original -> nome novo | código e nome da empresa | competência
```

e pergunta se pode enviar. Qualquer resposta afirmativa serve — "sim", "ok",
"confirmo", "simbora" —; quem interpreta a intenção é o modelo, não uma lista
fechada de palavras. Dúvida, pergunta ou pedido de mudança não são aprovação.

`processar_documentos`, que analisava e arquivava na mesma chamada, saiu do
alcance do agente. Continua registrada para rotinas automáticas, onde não há
ninguém na conversa para confirmar.

## Aprendizado: parar de perguntar todo mês

Duas tabelas, porque são duas perguntas diferentes:

| tabela | responde | chave |
|---|---|---|
| `empresa_contas` | de quem é | número da conta, só dígitos |
| `padroes_documento` | o que é | layout (colunas, ou esqueleto do cabeçalho) |

A conta é o sinal que unifica formatos: a mesma `1.136.082-8` aparece no PDF do
extrato, no PDF de investimentos e no OFX. Normalizada, os três casam. **A
agência fica fora da chave** — o mesmo banco escreve "5004-0" numa tela e "5004"
em outra.

Isso resolve o pior problema observado em teste real: num extrato, os números
`147` e `210` — códigos de dois clientes — apareciam como valores no meio dos
lançamentos, e o documento era recusado por ambiguidade. A conta identifica o
titular e não coincide com um valor qualquer.

**Não é modelo treinado.** É memória de decisão humana: só entra o que alguém
confirmou, vale desde a primeira confirmação, dá para auditar linha a linha e não
deriva sozinho.

Salvaguardas:

- Conta já cadastrada para outra empresa **não troca de dono**. Pode ser erro de
  cadastro ou conta transferida; sobrescrever mandaria os extratos do titular
  antigo para a pasta do novo, em silêncio.
- Conta cadastrada discordando do CNPJ do documento vira **conflito**, não
  escolha.
- Gravar o aprendizado é **melhor-esforço, fora da transação** do
  enfileiramento. Falhar ali não pode desfazer um arquivamento já autorizado —
  na pior hipótese o sistema volta a perguntar no mês seguinte.

Asserções: `npm run test:aprendizado` (em memória) e `npm run test:migrations`
(Postgres em Docker, asserção por asserção).
