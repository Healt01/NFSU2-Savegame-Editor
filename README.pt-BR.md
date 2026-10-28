# NFSU2-Savegame-Editor

[![abrir o editor](https://img.shields.io/badge/abrir%20o%20editor-online-brightgreen)](https://healt01.github.io/NFSU2-Savegame-Editor/)
![roda 100% offline](https://img.shields.io/badge/roda-100%25%20offline-blue)
![PC · Xbox · port do Switch](https://img.shields.io/badge/PC%20%C2%B7%20Xbox%20%C2%B7%20port%20do%20Switch-informational)
[![licença: MIT](https://img.shields.io/github/license/Healt01/NFSU2-Savegame-Editor?label=licen%C3%A7a)](LICENSE)
[![assistido por IA, testado no jogo](https://img.shields.io/badge/assistido%20por%20IA-testado%20no%20jogo-yellow)](#como-este-trabalho-foi-feito)

[English](README.md) · **Português (Brasil)**

Editor de save do **Need for Speed: Underground 2** para PC, Xbox original (xemu) e o
port do Switch [`nfsu2-sw`](https://github.com/antoxa2584x/nfsu2-sw). Roda inteiro no
navegador: o arquivo é lido e remontado na sua máquina, nada é enviado.

Editor original de [hackch](https://github.com/hackch/NFSU2-Savegame-Editor) (MIT).
Esta fork acrescenta a assinatura do Xbox, para que o jogo aceite o save editado, e os
campos de desempenho de carro.

## Como usar

Abra o [`index.html`](index.html) no navegador (o GitHub Pages serve ele a partir da
branch `main`), escolha o arquivo de save, edite, **Apply**, baixe.

| Campo | PC | Xbox / port do Switch |
|-------|----|------------------------|
| Dinheiro | `int32` com sinal em `0xA16A` | `int32` com sinal em `0xA19A` |
| Nome do perfil | 16 bytes em `0xD225` | 8 bytes em `0xD219`, maiúsculas, 7 caracteres |
| Slots de carro | vetor em `0x5AEC`, 5 slots de `0x7F2` | vetor em `0x5B1C`, mesmo tamanho |

Limites que o jogo impõe: o dinheiro precisa ficar em `1..2147483647` (acima disso
vira negativo), 5 slots de save sem como comprar ou vender vaga no jogo, e nome de
perfil do Xbox com no máximo 7 caracteres maiúsculos. O valor `2147483647` aparece
corretamente e fica negativo depois de uma corrida, porque o prêmio soma no mesmo
`int32`.

## O save do Xbox é assinado

O jogo recusa um save cuja assinatura não bate, então o save editado precisa ser
re-assinado. A assinatura são três campos HMAC-SHA1, e o editor recalcula os três
quando você aplica as mudanças, na ordem que o jogo usa:

| Campo | Cobre |
|-------|-------|
| `blob` @ `0x10` | os dois campos de tamanho em `0x4C..0x54` |
| `sigA` @ `0x24` | o payload, de `0x54` até o fim do arquivo |
| `sigB` @ `0x38` | `0x00..0x38`, que inclui `blob` e `sigA` |

O `sigB` cobre os outros dois, por isso ele é calculado por último.

**Chave.** A chave não está no binário do jogo e não está crua no `eeprom.bin`: o xemu
a deriva do EEPROM no boot, então cada instalação e cada console usa a sua, e não há
nada universal para publicar. Tire a sua com `tools/xbox_key.py`, que a encontra num
dump de RAM do convidado e a verifica contra um save, e cole no campo de chave do
editor. O port do Switch é a exceção: o kernel dele zera a chave do EEPROM
(`xboxrecomp/src/kernel/kernel_xbox.c`), então os saves dele são assinados com chave
toda zero, que é o que o botão **Fill port key** escreve para você.

## Desempenho do carro

Cada slot de carro guarda 68 flags de "peça instalada" em `slot + 0x94` e 10 valores
de desempenho em `float32` em `slot + 0x40` (índices 1..10, `3.00` é o máximo, o
índice 0 não é valor). O jogo calcula os valores a partir das peças instaladas, então
escrever os valores sem as flags não faz nada.

**Max out** escreve o padrão que um carro no máximo tem no jogo: 40 flags em posições
fixas, compartilhadas entre carros, mais `3.00` nos valores. **Nill out** limpa os
dois. Verificado no port do Switch: um slot escrito com esse padrão mostra as mesmas
barras da garagem de um carro levado ao máximo comprando todas as peças.

Detalhes, offsets, o layout do port no cartão SD e os testes no jogo estão em
[`FORMAT.md`](FORMAT.md) (inglês).

## Ferramentas

| Ferramenta | O que faz |
|------------|-----------|
| `tools/xbox_sign.py` | Assina ou verifica um save do Xbox offline (`sign` / `verify`). |
| `tools/xbox_key.py` | Acha a chave de 16 bytes num dump de RAM/core e a verifica contra um save. |
| `tools/hdd_save.py` | Lista, extrai ou substitui um save numa imagem qcow2 do xemu, numa imagem raw, ou num arquivo de save solto. |
| `tools/xemu_money.py` | Acha e corrige o valor do banco na RAM do convidado de um xemu em execução. |
| `tools/perf_diff.py` | Compara os slots de carro de dois saves: as flags e os outros bytes de slot que mudaram. |
| `tools/perf_probe.sh` | Fotografa um slot do cartão montado em `snapshots/snapN` e compara com `snapN-1`. |
| `tools/browser_capture.py` | Serve a página do editor e grava um POST do navegador, para comparar os bytes que o editor produz com os dos ferramentas em Python. |

## No jogo

| Plataforma | Resultado |
|------------|-----------|
| PC | Save editado abre, porque o save do PC não tem assinatura. **Não re-testado no trabalho desta fork** — essa linha é o registro anterior do projeto, mantido por completude. |
| xemu | Save editado sem re-assinar → `Unable to load`; re-assinado → abre, e o banco novo aparece. |
| Port do Switch | Sem re-assinar → `Unable to load`; re-assinado com a chave zero → abre. Dinheiro `100000` e `2147483647` aparecem certo; o padrão maxed deixa o carro no máximo. |

No port do Switch, os saves são pastas simples
`switch/nfsu2x/game/UDATA/<titleid>/<prefix+slot>/<name>` ao lado de `saveimage.xbx`
e `SaveMeta.xbx`, então um save editado e re-assinado é copiado com ferramentas comuns
de arquivo. Mantenha os dois arquivos `.xbx` junto do save.

## Como este trabalho foi feito

O código e a documentação desta fork foram rascunhados com modelos de IA rodando
localmente (llama.cpp, nesta máquina, sem serviço de nuvem, nada enviado), e
verificados por mim no jogo, no meu hardware: meu xemu, meu Switch modificado, meus
saves. As decisões de engenharia reversa são minhas, e a chave de assinatura de um
console é omitida da publicação de propósito.

O que se afirma aqui se apoia num teste, não num modelo: o esquema de assinatura foi
reproduzido byte-a-byte contra saves escritos pelo jogo, o padrão de carro no máximo
veio de um slot que o próprio jogo produziu, e a saída do editor no navegador foi
comparada byte-a-byte com as ferramentas em Python (`sha1
9bb79a96c3ccd249bf897dda271cbb8892a28c1b`), que depois abriu no jogo no port do
Switch. Os resultados, os offsets e as tabelas de teste no jogo estão em
[`FORMAT.md`](FORMAT.md).

O que não foi testado está marcado como não testado. Sem vínculo com Electronic Arts
ou Criterion; isto é para modificar os seus próprios saves, uso pessoal.

## Licença

MIT, veja [`LICENSE`](LICENSE). Copyright do editor original: Christopher Hack.
