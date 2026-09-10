// Leitura do cadastro e das pastas. Não classifica com IA e não grava arquivos.
import { access } from "node:fs/promises";
process.loadEnvFile(".env");
process.loadEnvFile(".env.local");
const { portasAnalisePadrao } = await import("../lib/arquivador/portas-analise");
const { expandirDestino } = await import("../lib/arquivador/caminhos");
const portas = portasAnalisePadrao();
const empresas = await portas.listarEmpresasVisiveis("verificacao_local");
const empresa = empresas.find(e => e.codigo === "210");
if (!empresa) throw new Error("Cliente 210 não encontrado.");
const regra = (await portas.listarRegrasAtivas()).find(r => r.codigo === "MENSAL_EXTRATOS_INVESTIMENTOS");
if (!regra) throw new Error("Regra de extratos não encontrada.");
const container = await portas.nomePastaClientes(empresa.ativo);
const pasta = await portas.nomePastaEmpresa!(container, empresa.codigo!);
const destino = expandirDestino(regra, { empresaId: empresa.id, empresaCodigo: empresa.codigo,
  empresaNome: empresa.razao_social, pastaEmpresa: pasta, pastaClientes: container, competencia: "2026-07",
  instituicao: "VERIFICACAO_DE_CAMINHO" });
if (!destino.ok) throw new Error(destino.erro);
const esperado = "01_CLIENTES_ATIVOS/210-TL ACADEMIA/2026/07.2026";
if (destino.caminhoLogico !== esperado) throw new Error(`Destino divergente: ${destino.caminhoLogico}`);
const raiz = "C:/Users/user/GESTAO CONTABIL SERVICOS CONTABEIS LTDA - ME/Gestao - CONTROLE GERAL/001 - EFFECTIVE BPO/PASTAS_V2";
await access(`${raiz}/${esperado}`);
console.log(`OK: ${raiz}/${esperado}`);
