import type { TradingPlatform } from './tradingPlatform'

export interface ConnectTradingAccountForm {
  label: string
  platform: TradingPlatform
  account_number: string
  account_password: string
  broker_server: string
}

export const emptyConnectTradingAccountForm: ConnectTradingAccountForm = {
  label: '',
  platform: 'MT5',
  account_number: '',
  account_password: '',
  broker_server: '',
}
