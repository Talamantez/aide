/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';

export interface CSAuthenticationSession {
	id: string;
	accessToken: string;
	refreshToken: string;
	account: CSUser;
}

export type CSUser = {
	id: string;
	first_name: string;
	last_name: string;
	email: string;
	created_at: string;
	updated_at: string;
	email_verified: boolean;
	profile_picture_url: string;
};

export type EncodedCSTokenData = {
	access_token: string;
	refresh_token: string;
};

export type CSUserProfileResponse = {
	user: CSUser;
};

export const ICSAccountService = createDecorator<ICSAccountService>('csAccountService');
export interface ICSAccountService {
	readonly _serviceBrand: undefined;

	toggle(): void;
}

export const ICSAuthenticationService = createDecorator<ICSAuthenticationService>('csAuthenticationService');
export interface ICSAuthenticationService {
	readonly _serviceBrand: undefined;
	readonly onDidAuthenticate: Event<CSAuthenticationSession>;

	createSession(): Promise<CSAuthenticationSession>;
	deleteSession(sessionId: string): Promise<void>;
	refreshTokens(): Promise<void>;
	getSession(): Promise<CSAuthenticationSession | undefined>;
}
