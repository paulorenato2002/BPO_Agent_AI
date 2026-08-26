"use client";

import { IconeArquivo, IconeCheck, IconeAlerta } from "./icones";
import { formatarTamanho, type CartaoArquivoDados, type DestinoArmazenamento } from "./tipos";

/**
 * Cartão de resultado do armazenamento de um arquivo.
 *
 * REGRA: "Sucesso" só aparece quando o backend confirmou de fato. Se um destino
 * funcionou e o outro não, o cartão mostra "armazenamento parcial" — nunca um
 * verde geral que esconderia a falha.
 */
export function CartaoArquivo({ dados }: { dados: CartaoArquivoDados }) {
  const comSucesso = dados.destinos.filter((d) => d.estado === "sucesso").length;
  const finalizados = dados.destinos.filter((d) =>
    ["sucesso", "erro", "nao_configurado"].includes(d.estado)
  ).length;

  const parcial =
    finalizados === dados.destinos.length && comSucesso > 0 && comSucesso < dados.destinos.length;
  const falhaTotal = finalizados === dados.destinos.length && comSucesso === 0;

  return (
    <div className="overflow-hidden rounded-xl border border-borda bg-fundo-cartao">
      <div className="flex items-start gap-3 p-4">
        <IconeArquivo extensao={dados.extensao} className="h-10 w-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-texto">
            {dados.nomePadronizado ?? dados.nomeOriginal}
          </p>
          <p className="mt-0.5 text-sm text-texto-suave">
            {formatarTamanho(dados.tamanhoBytes)}
            {dados.tamanhoBytes !== undefined && " • "}
            {dados.extensao.toUpperCase()}
          </p>

          {dados.nomePadronizado && dados.nomePadronizado !== dados.nomeOriginal && (
            <p className="mt-1 truncate text-xs text-texto-fraco">
              Original: {dados.nomeOriginal}
            </p>
          )}

          {(dados.empresa || dados.competencia || dados.tipoDocumento) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {dados.empresa && <Etiqueta>{dados.empresa}</Etiqueta>}
              {dados.competencia && <Etiqueta>{dados.competencia}</Etiqueta>}
              {dados.tipoDocumento && <Etiqueta>{dados.tipoDocumento}</Etiqueta>}
            </div>
          )}
        </div>
      </div>

      {dados.destinos.length > 0 && (
        <div className="border-t border-borda">
          {dados.destinos.map((destino) => (
            <LinhaDestino key={destino.provedor} destino={destino} />
          ))}
        </div>
      )}

      {parcial && (
        <p className="flex items-center gap-2 border-t border-borda bg-ambar-suave px-4 py-2.5 text-sm text-ambar">
          <IconeAlerta className="h-4 w-4" />
          Armazenamento parcial — nem todos os destinos confirmaram.
        </p>
      )}
      {falhaTotal && (
        <p className="flex items-center gap-2 border-t border-borda bg-vermelho-suave px-4 py-2.5 text-sm text-vermelho">
          <IconeAlerta className="h-4 w-4" />
          O arquivo não foi armazenado em nenhum destino.
        </p>
      )}
    </div>
  );
}

function Etiqueta({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-fundo-sutil px-2 py-0.5 text-xs text-texto-suave">
      {children}
    </span>
  );
}

function LinhaDestino({ destino }: { destino: DestinoArmazenamento }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-texto">{destino.nome}</p>
        {destino.local && (
          <p className="truncate text-xs text-texto-suave">{destino.local}</p>
        )}
        {destino.detalhe && destino.estado !== "sucesso" && (
          <p className="truncate text-xs text-texto-suave">{destino.detalhe}</p>
        )}
      </div>
      <SeloEstado estado={destino.estado} />
      {destino.estado === "sucesso" && destino.url && (
        <a
          href={destino.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg px-2 py-1 text-xs font-medium text-azul hover:bg-azul-suave"
        >
          Abrir
        </a>
      )}
    </div>
  );
}

function SeloEstado({ estado }: { estado: DestinoArmazenamento["estado"] }) {
  if (estado === "sucesso") {
    return (
      <span className="flex items-center gap-1.5 rounded-lg bg-verde-suave px-2.5 py-1.5 text-sm font-medium text-verde">
        <IconeCheck className="h-3.5 w-3.5" />
        Sucesso
      </span>
    );
  }
  if (estado === "erro") {
    return (
      <span className="rounded-lg bg-vermelho-suave px-2.5 py-1.5 text-sm font-medium text-vermelho">
        Erro
      </span>
    );
  }
  if (estado === "nao_configurado") {
    return (
      <span className="rounded-lg bg-ambar-suave px-2.5 py-1.5 text-sm font-medium text-ambar">
        Não configurado
      </span>
    );
  }
  if (estado === "enviando") {
    return (
      <span className="flex items-center gap-1.5 rounded-lg bg-fundo-sutil px-2.5 py-1.5 text-sm text-texto-suave">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-texto-fraco border-t-transparent" />
        Enviando
      </span>
    );
  }
  return (
    <span className="rounded-lg bg-fundo-sutil px-2.5 py-1.5 text-sm text-texto-suave">
      Aguardando
    </span>
  );
}
