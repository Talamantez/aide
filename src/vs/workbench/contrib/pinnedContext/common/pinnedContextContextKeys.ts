/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from 'vs/platform/contextkey/common/contextkey';

export const CONTEXT_HAS_PINNED_CONTEXT = new RawContextKey<boolean>('hasPinnedContext', false, { type: 'boolean', description: 'True when there are pinned contexts.' });
