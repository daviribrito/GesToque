# APIs do sistema

Fonte da verdade: tabela `routes` em `server/app.js`. Atualize este arquivo ao criar ou mudar uma rota.
A página `/duvidasdev` (só admin) mostra esta lista gerada direto da tabela, sempre em dia.

Tipo: REST com JSON sobre HTTPS (não é SOAP nem GraphQL). Autenticação: cookie de sessão opaco + token opaco `Bearer` (não é JWT).

## Como a API é protegida
| Acesso | O que exige |
|---|---|
| **aberto** | Nada de login. Ações (não-GET) exigem `X-GT: 1` e origem do próprio site. |
| **logado** | Cookie de sessão completa (senha + código do autenticador) **e** `Authorization: Bearer <token>`. Admin ou gestor. |
| **admin** | O mesmo que "logado", e o perfil precisa ser admin. |

- Token de acesso: entregue em `POST /api/entrar/codigo` e `GET /api/eu`; a tela guarda só na memória e manda em toda chamada (`api()` em `public/js/app.js`).
- Toda ação (POST, PUT, PATCH, DELETE), aberta ou não, exige `X-GT: 1` e origem do próprio site.
- Sem sessão, sem token ou com token errado: **401**. Perfil sem permissão: **403**.

## Lista
| Método | Caminho | Acesso | Para quê |
|---|---|---|---|
| POST | `/api/entrar` | aberto | Usuário e senha (1ª etapa do login) |
| POST | `/api/entrar/codigo` | aberto* | Código do autenticador (2ª etapa); devolve usuário + token |
| POST | `/api/sair` | aberto | Encerra a sessão deste navegador |
| GET | `/api/eu` | aberto | Quem está logado (ou `null`) + token |
| GET | `/api/novidades` | aberto | Notas de versão e ambiente (página pública /version e tarja de teste) |
| GET | `/api/versao` | logado | Versão atual |
| POST | `/api/eu/senha` | logado | Trocar a própria senha |
| POST | `/api/eu/ativo` | logado | Avisa uso (renova a sessão) |
| PATCH | `/api/eu/preferencias` | logado | "Manter ativo" |
| GET | `/api/eu/perfil` | logado | Perfil de quem está logado: nome, usuário, perfil, data de cadastro e foto |
| GET | `/api/eu/foto?u=<id>&v=<versão>` | logado | A própria foto (imagem). Cache privado de 1 ano no navegador; o endereço muda a cada troca. **Nunca entra no registro** |
| PUT | `/api/eu/foto` | logado | Insere ou troca a própria foto (`{ photo }`: data URL JPG/PNG/WEBP, até 256 KB) no Storage privado. Registro: "inserida"/"trocada", sem a imagem |
| DELETE | `/api/eu/foto` | logado | Remove a própria foto (apaga do Storage). Registro: "removida" |
| PATCH | `/api/eu/nome` | logado | Troca o próprio nome (`{ name }`); login, perfil e situação só o admin muda |
| GET | `/api/itens` | logado | Lista de itens do estoque |
| POST | `/api/itens` | logado | Cadastrar item |
| PATCH | `/api/itens/:id` | logado | Editar item |
| DELETE | `/api/itens/:id` | admin | Excluir item (arquiva em removidos) |
| GET | `/api/itens/removidos` | admin | Itens removidos |
| GET | `/api/itens/removidos/:id` | admin | Detalhe de um item removido |
| GET | `/api/itens/exportar` | logado | Exportar estoque (xlsx/csv) |
| POST | `/api/itens/importar` | logado | Importar planilha de estoque |
| GET | `/api/movimentacoes` | logado | Lista de movimentações |
| POST | `/api/movimentacoes` | logado | Lançar entrada, saída ou contagem |
| GET | `/api/movimentacoes/exportar` | logado | Exportar movimentações |
| POST | `/api/movimentacoes/importar` | logado | Importar planilha de movimentações |
| GET | `/api/compras` | logado | Histórico de compras |
| GET | `/api/previsao` | logado | Previsão de compra (faturas) |
| PUT | `/api/metricas` | admin | Salvar métricas da previsão |
| GET | `/api/estimativas` | logado | Estimativa de uso de um item |
| GET | `/api/estimativas/manuais` | logado | Todas as estimativas manuais |
| PUT | `/api/estimativas` | logado | Salvar estimativa manual |
| DELETE | `/api/estimativas/:id` | logado | Voltar ao automático |
| GET | `/api/usuarios` | admin | Lista de usuários |
| POST | `/api/usuarios` | admin | Criar usuário |
| PATCH | `/api/usuarios/:id` | admin | Editar, desativar, trocar senha, liberar, refazer autenticador |
| GET | `/api/solicitacoes` | logado | Solicitações de usuário (gestor vê as dele) |
| POST | `/api/solicitacoes` | logado | Gestor pede um usuário novo |
| GET | `/api/solicitacoes/pendentes` | admin | Quantas aguardam (sino) |
| POST | `/api/solicitacoes/:id/aprovar` | admin | Aprovar (cria o usuário) |
| POST | `/api/solicitacoes/:id/recusar` | admin | Recusar |
| GET | `/api/dev/documentacao` | admin | Conteúdo da documentação técnica (/duvidasdev) + lista de rotas |
| GET | `/api/logs` | admin | Registro da API (/partner), sem o JSON. Filtros: `antes`, `resultado` (sucesso/erro/negado), `metodo`, `busca`, `de`, `ate` |
| GET | `/api/logs/:id` | admin | Pedido e resposta completos de uma chamada |
| GET | `/api/sql/tabelas` | admin | Consulta SQL: tabelas e colunas que o papel de leitura enxerga |
| POST | `/api/sql` | admin | Consulta SQL só de leitura (`{ sql }`), papel `gestoque_leitura`, até 1000 linhas e 8 s |

## Registro (`gestoque.api_logs`)
Grava ações (não-GET, menos `/api/eu/ativo`), exportações e qualquer pedido com status ≥ 400. Da Consulta SQL (`POST /api/sql`) guarda o SQL e um resumo, nunca as linhas do resultado. Imagens embutidas (`data:...`, ex.: foto do perfil) viram um resumo com o tamanho. Nunca gravados, nem com erro: `POST /api/eu/ativo` e `GET /api/eu/foto` (`NEVER_LOG` em `server/logs.js`).

## Fotos de perfil (Supabase Storage)
- Bucket **privado** `fotos-perfil` (256 KB, só JPG/PNG/WEBP), criado pela migração. RLS ligado em `storage.objects` + política **restritiva** `fotos_perfil_fechado`, que nega tudo a `anon` e `authenticated` nesse bucket. Sem link público nem assinado: a foto só sai pela API, para quem está logado.
- O servidor usa a chave de serviço (`SUPABASE_SERVICE_ROLE_KEY`; no Preview, `_Dev`). Endereço tirado do `DATABASE_URL`. Banco local: `data/fotos/`.
- Banco: `users.photo_key` (caminho `usuarios/<id>`), `photo_type`, `photo_version`. `users.photo` (data URL da 1ª versão) é levado ao Storage na 1ª leitura do perfil. Pedido e resposta em `json` (ordem exata), com senhas/códigos/tokens como `***`, até 16 KB cada. Guarda 90 dias: o pg_cron do Supabase apaga o mais velho todo dia às 03:30 (Brasília) e faz `VACUUM` aos domingos; o servidor tem uma limpeza de reserva a cada 6 h. Código em `server/logs.js`.

\* `/api/entrar/codigo` só funciona com a sessão provisória criada por `/api/entrar` (senha certa, válida por 10 min).
