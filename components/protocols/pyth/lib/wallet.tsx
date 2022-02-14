import {Cluster, clusterApiUrl, Connection} from '@solana/web3.js';
import {Keypair} from '@solana/web3.js';
import {message} from 'antd';
import axios from 'axios';
import bs58 from 'bs58';
import _, {initial} from 'lodash';
import {useCallback, useEffect, useState} from 'react';
import useSWR from 'swr';
import {SOLANA_NETWORKS} from 'types';
import {JupiterSwapClient, OrcaSwapClient, SwapResult} from './swap';
import {useLocalStorage} from './useLocalStorage';

interface WalletBalance {
  sol_balance: number;
  usdc_balance: number;
  orca_balance: number;
}

export interface Order {
  side: 'buy' | 'sell';
  size: number;
  fromToken: string;
  toToken: string;
}

export const SERUM_RPC_URL = 'https://solana-api.projectserum.com/';

const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
const DEVNET_USDC_MINT_ADDRESS = 'EmXq3Ni9gfudTiyNKzzYvpnQqnJEMRw2ttnVXoJXjLo1';
const MAINNET_USDC_MINT_ADDRESS =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ORCA_MINT_ADDRESS = 'orcarKHSqC5CDDsGbho8GKvwExejWHxTqGzXgcewB9L';

export const SOL_DECIMAL = 10 ** 9;
export const USDC_DECIMAL = 10 ** 6;
export const ORCA_DECIMAL = 10 ** 6;

export const useExtendedWallet = (
  useLive = false,
  cluster: Cluster,
  price: number = 0,
) => {
  const [secretKey, setSecretKey] = useLocalStorage<string>('secretKey', '');
  const [keyPair, setKeyPair] = useState<Keypair>(Keypair.generate());
  useEffect(() => {
    if (secretKey) {
      let array = Uint8Array.from(bs58.decode(secretKey));
      const key = Keypair.fromSecretKey(array);
      setKeyPair(key);
    } else {
      const temp = Keypair.generate(); // The mock uses a random keypair to be able to get real market data.
      setKeyPair(temp);
    }
  }, [secretKey]);

  const [balance, setBalance] = useState<WalletBalance>({
    sol_balance: 10 * SOL_DECIMAL,
    usdc_balance: 1400 * USDC_DECIMAL,
    orca_balance: 0 * ORCA_DECIMAL, // ORCA token is only used on devnet
  });

  // State for tracking user worth with current Market Price.
  const [worth, setWorth] = useState({
    initial: 0,
    current: 0,
    change: 0,
  });

  const updateCurrentWorth = (updateInitial = false) => {
    const solWorth = (balance.sol_balance / SOL_DECIMAL) * price;
    const usdcWorth = balance.usdc_balance / USDC_DECIMAL;
    const currentWorth = solWorth + usdcWorth;
    if (updateInitial) {
      setWorth((worth) => ({
        ...worth,
        initial: currentWorth,
        current: currentWorth,
        change: 0,
      }));
    } else {
      setWorth((worth) => ({
        ...worth,
        current: currentWorth,
        change: calculateChange(worth.initial, currentWorth),
      }));
    }
  };

  const calculateChange = (initial: number, current: number): number => {
    return (initial / current) * 100 - 100;
  };

  // update the current worth each price update.
  useEffect(() => {
    if (price) {
      if (worth.initial === 0) {
        updateCurrentWorth(true);
      } else {
        updateCurrentWorth();
      }
    }
  }, [price]);

  const [orderBook, setOrderbook] = useState<Order[]>([]);

  const {data, mutate} = useSWR(
    () => `/balance/${keyPair?.publicKey}`, // Cache key based on the keypair.
    balanceFetcher(keyPair!, cluster),
    {
      refreshInterval: 5000,
    },
  );

  useEffect(() => {
    mutate(); // Refresh balance
  }, [cluster]);

  useEffect(() => {
    if (data && useLive) {
      /**
       * Documentation for  _.get https://lodash.com/docs/4.17.15#get
       */
      const sol_balance = _.get(data, 'data[0].result.value', 0);
      const usdc_balance = _.get(
        data,
        'data[1].result.value[0]account.data.parsed.info.tokenAmount.amount',
        0,
      );
      const orca_balance = _.get(
        data,
        'data[2].result.value[0]account.data.parsed.info.tokenAmount.amount',
        0,
      );
      setBalance({sol_balance, usdc_balance, orca_balance});
    }
  }, [data]);

  /**
   *  Since jup.ag does not support devnet yet, we'll use Orca for devnet swaps.
   */
  const [orcaSwapClient, setOrcaSwapClient] = useState<OrcaSwapClient | null>(
    null,
  );

  // useEffect(() => {
  //   (async function _init(): Promise<void> {
  //     console.log('Keypair changed to: ', keyPair?.publicKey.toBase58());
  //     console.log('setting up clients');
  //     setJupiterSwapClient(null);
  //     setOrcaSwapClient(null);
  //     await getOrcaSwapClient();
  //     await getJupiterSwapClient();
  //     console.log('clients initialized');
  //   })();
  // }, [keyPair]);

  const getOrcaSwapClient = async () => {
    console.log('setting up orca client');
    if (orcaSwapClient) return orcaSwapClient;
    const _orcaSwapClient = new OrcaSwapClient(
      keyPair,
      new Connection(clusterApiUrl('devnet'), 'confirmed'),
    );
    setOrcaSwapClient((c) => _orcaSwapClient);
    return _orcaSwapClient;
  };

  /**
   * The Jupiter SDK gives access to 10+ DEXes with more than 6bn in liquidity, allowing developers to find the best swap route with a simple API call.
   */
  const [jupiterSwapClient, setJupiterSwapClient] =
    useState<JupiterSwapClient | null>(null);

  const getJupiterSwapClient = async () => {
    console.log('setting up jupiter client');
    if (jupiterSwapClient) return jupiterSwapClient;
    const _jupiterSwapClient = await JupiterSwapClient.initialize(
      // Why not use clusterApiUrl('mainnet') over projectserum? Because mainnet public endpoints have rate limits at the moment.
      new Connection(SERUM_RPC_URL, 'confirmed'),
      SOLANA_NETWORKS.MAINNET,
      keyPair,
      SOL_MINT_ADDRESS,
      MAINNET_USDC_MINT_ADDRESS,
    );
    setJupiterSwapClient((c) => _jupiterSwapClient);
    return _jupiterSwapClient;
  };

  const addMockOrder = async (order: Order): Promise<SwapResult> => {
    const _jupiterSwapClient = await getJupiterSwapClient();

    // TokenA === SOL
    // TokenB === USDC
    const routes = await _jupiterSwapClient?.getRoutes({
      inputToken:
        order.side === 'buy'
          ? _jupiterSwapClient.tokenB
          : _jupiterSwapClient.tokenA,
      outputToken:
        order.side === 'buy'
          ? _jupiterSwapClient.tokenA
          : _jupiterSwapClient.tokenB,
      inputAmount: order.size,
      slippage: 1,
    });
    console.log('routes:', routes);
    const bestRoute = routes?.routesInfos[0];
    console.log('bestRoute:', bestRoute);
    const result = {
      inAmount: bestRoute?.inAmount || 0,
      outAmount: bestRoute?.outAmount || 0,
      txIds: [
        `mockTransaction_${Math.abs(Math.random()).toString().slice(2, 8)}`,
      ],
    };

    // Balance change for the mock wallet. This is not an actual transaction.
    setBalance((previousBalance) => ({
      ...previousBalance,
      usdc_balance:
        order.side === 'buy'
          ? previousBalance.usdc_balance - result.inAmount
          : previousBalance.usdc_balance + result.outAmount,
      sol_balance:
        order.side === 'buy'
          ? previousBalance.sol_balance + result.outAmount
          : previousBalance.sol_balance - result.inAmount,
    }));

    return result;
  };

  const [devnetToMainnetPriceRatioRef, setDevnetToMainnetPriceRatioRef] =
    useState<{
      sol_usdc: number;
      usdc_sol: number;
    }>({
      sol_usdc: 1,
      usdc_sol: 1,
    });

  const addOrder = useCallback(
    async (order: Order) => {
      console.log('addOrder', useLive, order, cluster);
      let result: SwapResult;
      if (!useLive) {
        result = await addMockOrder(order);
      } else if (useLive) {
        if (cluster === 'devnet') {
          const _orcaClient = await getOrcaSwapClient();
          if (order.side === 'buy') {
            result = await _orcaClient?.buy(order.size)!;
            const inAmountHumanReadable = result.inAmount / USDC_DECIMAL;
            const outAmountHumanReadable = result.outAmount / SOL_DECIMAL;
            setDevnetToMainnetPriceRatioRef((prev) => ({
              ...prev,
              usdc_sol: inAmountHumanReadable / outAmountHumanReadable,
            }));
            console.log('result:', result);
          } else if (order.side === 'sell') {
            if (order.toToken === 'ORCA') {
              console.log(_orcaClient);
              result = await _orcaClient?.sell_to_orca(order.size)!;
              console.log('result:', result);
            } else if (order.toToken === 'USDC') {
              result = await _orcaClient?.sell(order.size)!;
              const inAmountHumanReadable = result.inAmount / SOL_DECIMAL;
              const outAmountHumanReadble = result.outAmount / USDC_DECIMAL;
              setDevnetToMainnetPriceRatioRef((prev) => ({
                ...prev,
                sol_usdc: inAmountHumanReadable / outAmountHumanReadble,
              }));
              console.log('result:', result);
            }
          } else {
            console.log('Impossible!');
          }
        } else if (cluster === 'mainnet-beta') {
          console.log(jupiterSwapClient?.keypair.publicKey.toString());
          const _jupiterSwapClient = await getJupiterSwapClient();
          console.log(_jupiterSwapClient?.keypair.publicKey.toString());
          if (order.side === 'buy') {
            result = await _jupiterSwapClient?.buy(order.size);
          } else if (order.side === 'sell') {
            result = await _jupiterSwapClient?.sell(order.size);
          }
        }
      }
      if (result!) {
        const extendedOrder = {...order, ...result};
        setOrderbook((_orderBook) => [extendedOrder, ..._orderBook]);
      }

      mutate(); // Refresh balance
    },
    [useLive, cluster, keyPair, devnetToMainnetPriceRatioRef],
  );

  const resetWallet = (
    params = {sol_balance: 10, usdc_balance: 1400, orca_balance: 0},
  ) => {
    if (useLive) {
      setSecretKey('');
    } else {
      setBalance({
        sol_balance: params.sol_balance * SOL_DECIMAL,
        usdc_balance: params.usdc_balance * USDC_DECIMAL,
        orca_balance: params.orca_balance * ORCA_DECIMAL,
      });
      updateCurrentWorth(true);
    }
  };

  return {
    balance,
    resetWallet,
    keyPair,
    setSecretKey,
    secretKey,
    addOrder,
    orderBook,
    worth,
    devnetToMainnetPriceRatioRef,
  };
};

const balanceFetcher = (keyPair: Keypair, cluster: Cluster) => () =>
  // @ts-ignore
  axios({
    url: cluster === 'devnet' ? clusterApiUrl(cluster) : SERUM_RPC_URL,
    method: 'post',
    headers: {'Content-Type': 'application/json'},
    data: [
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'getBalance', // SOL balance.
        params: [keyPair?.publicKey.toBase58()],
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner', // https://docs.solana.com/developing/clients/jsonrpc-api#gettokenaccountsbyowner
        params: [
          keyPair?.publicKey.toBase58(),
          {
            mint:
              cluster === 'devnet'
                ? DEVNET_USDC_MINT_ADDRESS
                : MAINNET_USDC_MINT_ADDRESS,
          },
          {
            encoding: 'jsonParsed',
          },
        ],
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'getTokenAccountsByOwner', // https://docs.solana.com/developing/clients/jsonrpc-api#gettokenaccountsbyowner
        params: [
          keyPair?.publicKey.toBase58(),
          {
            mint: ORCA_MINT_ADDRESS, // Required as a midway swap token for devnet swaps using Orca.
          },
          {
            encoding: 'jsonParsed',
          },
        ],
      },
    ],
  });