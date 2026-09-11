# Telegram Public Link Crawler (Política BR)

Este projeto implementa um crawler em Node.js para descobrir links públicos do Telegram (https://t.me/USERNAME) relacionados à política brasileira.

ATENÇÃO / Ética:
- Não usa autenticação.
- Não entra em grupos privados.
- Coleta apenas URLs públicas.

Requisitos
- Node.js 18+ (recomendado)
- npm

Instalação
1. Clone o repositório:
   git clone https://github.com/chrischimith/telegram-link-crawler-br
   cd telegram-link-crawler-br

2. Crie os arquivos (se ainda não existirem) — os arquivos necessários estão em src/
   (Se você recebeu estes arquivos via este README, salve-os nos paths indicados.)

3. Instale dependências:
   npm install

Teste rápido (50 resultados)
Execute o crawler com o teste que valida o comportamento e gera os arquivos na pasta output/:

node src/index.js --max-results 50 --max-depth 1 --request-delay 500 --concurrency 2

Arquivos gerados (durante/ao final)
- output/results.json — JSON bruto com todos os resultados
- output/results.csv — CSV completo (regravado em checkpoints)
- output/state.json — checkpoint com estado para retomar

Colunas CSV:
nome,username,telegram_url,tipo,descricao,categoria,estado,cidade,fonte,data_coleta

Observações
- Ajuste `--request-delay` e `--concurrency` conforme sua conexão e para evitar bloqueios.
- O crawler utiliza Bing HTML público para buscas. Para uso em escala considere uma API de busca paga.
