from pathlib import Path

destino = Path(
    r"C:\Users\user\Desktop\Programacao\EFFECTIVE"
    r"\Ambiente Effective\Agente BPO\pastas_modelo"
)

for ano in range(2025, 2031):
    for mes in range(1, 13):
        pasta = destino / str(ano) / f"{mes:02d}.{ano}"
        pasta.mkdir(parents=True, exist_ok=True)

print(f"Concluído! Pastas de 2025 a 2030 disponíveis em:\n{destino}")