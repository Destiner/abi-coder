import {
	JsonFragment,
	JsonFragmentType,
	ParamType,
	Result,
	defaultAbiCoder,
} from '@ethersproject/abi';
import * as sha3 from 'js-sha3';

interface Param {
	name?: string;
	type?: string;
	components?: JsonFragmentType[];
	value: unknown;
}

interface EventParam extends Param {
	indexed?: boolean;
}

interface FunctionData {
	name: string;
	params: Param[];
}

interface Event {
	name: string;
	params: EventParam[];
}

interface EventEncoding {
	topics: string[];
	data: string;
}

class Coder {
	private abi: JsonFragment[];

	constructor(abi: JsonFragment[]) {
		this.abi = abi;
	}

	static toResult(params: Param[]): Result {
		return params.map((param) => param.value);
	}

	toEventParams(name: string, result: Result): EventParam[] {
		const event = this.getEventByName(name);
		const inputs = event?.inputs;
		if (!inputs) {
			return [];
		}
		return inputs
			.map((input, index) => {
				return {
					name: input.name,
					type: input.type,
					components: input.components,
					value: result[index],
					indexed: input.indexed,
				} as Param;
			})
			.filter((param): param is EventParam => !!param.name);
	}

	toFunctionParams(name: string, result: Result): Param[] {
		const func = this.getFunctionByName(name);
		const inputs = func?.inputs;
		if (!inputs) {
			return [];
		}
		return inputs
			.map((input, index) => {
				return {
					name: input.name,
					type: input.type,
					components: input.components,
					value: result[index],
				} as Param;
			})
			.filter((param) => !!param.name);
	}

	toConstructorParams(result: Result): Param[] {
		const constructor = this.getConstructor();
		const inputs = constructor?.inputs;
		if (!inputs) {
			return [];
		}
		return inputs
			.map((input, index) => {
				return {
					name: input.name,
					type: input.type,
					components: input.components,
					value: result[index],
				} as Param;
			})
			.filter((param) => !!param.name);
	}

	getFunctionSelector(name: string): string | undefined {
		const func = this.getFunctionByName(name);
		const jsonInputs = func?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const signature = Coder.getSignature(name, inputs);
		const hash = sha3.keccak256(signature);
		return `0x${hash.substring(0, 8)}`;
	}

	getEventTopic(name: string): string | undefined {
		const event = this.getEventByName(name);
		const jsonInputs = event?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const signature = Coder.getSignature(name, inputs);
		const hash = sha3.keccak256(signature);
		return `0x${hash}`;
	}

	decodeConstructor(data: string): Param[] {
		const constructor = this.getConstructor();
		const jsonInputs = constructor?.inputs;
		if (!jsonInputs) {
			return [];
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const result = defaultAbiCoder.decode(inputs, data);
		const params = this.toConstructorParams(result);
		return params;
	}

	decodeEvent(topics: string[], data: string): Event | undefined {
		const event = this.getEventByTopic(topics[0]);
		const [, ...dataTopics] = topics;
		const jsonInputs = event?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		// Decode topics
		const topicInputs = inputs.filter((input) => input.indexed);
		const topicResult = topicInputs.map((input, index) => {
			const topic = dataTopics[index];
			const params = defaultAbiCoder.decode([input], topic);
			const [param] = params;
			return param;
		});
		// Decode data
		const dataInputs = inputs.filter((input) => !input.indexed);
		const dataResult = defaultAbiCoder.decode(dataInputs, data);
		// Convert to params
		if (!event.name) {
			return;
		}
		const topicParams = this.toEventParams(event.name, topicResult);
		const dataParams = this.toEventParams(event.name, dataResult);
		const allParams = [...topicParams, ...dataParams];
		const params: EventParam[] = [];
		// let topicParamIndex = 0;
		// let dataParamIndex = 0;
		for (const input of inputs) {
			const param = allParams.find((param) => param.name === input.name);
			if (!param) {
				continue;
			}
			params.push(param);
		}
		return {
			name: event.name,
			params,
		};
	}

	decodeFunction(data: string): FunctionData | undefined {
		const selector = data.substring(0, 10);
		const func = this.getFunctionBySelector(selector);
		// Decode calldata using function inputs
		const jsonInputs = func?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const calldata = `0x${data.substring(10)}`;
		const result = defaultAbiCoder.decode(inputs, calldata);

		if (!func.name) {
			return;
		}
		const params = this.toFunctionParams(func.name, result);
		return {
			name: func.name,
			params,
		};
	}

	encodeConstructor(params: Param[]): string | undefined {
		const constructor = this.getConstructor();
		const jsonInputs = constructor?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const data = defaultAbiCoder.encode(inputs, params);
		return `0x${data}`;
	}

	encodeEvent(eventData: Event): EventEncoding | undefined {
		const { name, params } = eventData;
		const event = this.getEventByName(name);
		const jsonInputs = event?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const eventSignature = Coder.getSignature(name, inputs);
		const eventTopic = `0x${sha3.keccak256(eventSignature)}`;
		// Group params by type
		const topicParams: EventParam[] = [];
		const dataParams: EventParam[] = [];
		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i];
			const param = params[i];
			if (input.indexed) {
				topicParams.push(param);
			} else {
				dataParams.push(param);
			}
		}
		// Encode topic params
		const topicInputs = inputs.filter((input) => input.indexed);
		const dataTopics = topicInputs.map((input, index) =>
			defaultAbiCoder.encode([input], [topicParams[index]]),
		);
		const topics = [eventTopic, ...dataTopics];
		// Encode data params
		const dataInputs = inputs.filter((input) => !input.indexed);
		const data = defaultAbiCoder.encode(dataInputs, dataParams);

		return {
			topics,
			data,
		};
	}

	encodeFunction(functionData: FunctionData): string | undefined {
		const { name, params } = functionData;
		const func = this.getFunctionByName(name);
		const jsonInputs = func?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const signature = Coder.getSignature(name, inputs);
		const selector = sha3.keccak256(signature).substring(0, 8);
		const argumentString = defaultAbiCoder.encode(inputs, params);
		const argumentData = argumentString.substring(2);
		const inputData = `0x${selector}${argumentData}`;
		return inputData;
	}

	private getConstructor(): JsonFragment | undefined {
		return this.abi.find((item) => item.type === 'constructor');
	}

	private getFunctionByName(name: string): JsonFragment | undefined {
		return this.abi.find(
			(item) => item.type === 'function' && item.name === name,
		);
	}

	private getFunctionBySelector(selector: string): JsonFragment | undefined {
		const functions = this.abi.filter((item) => item.type === 'function');
		const func = functions.find((func) => {
			const name = func.name;
			const jsonInputs = func.inputs;
			if (!name || !jsonInputs) {
				return false;
			}
			const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
			const signature = Coder.getSignature(name, inputs);
			const hash = sha3.keccak256(signature);
			const funcSelector = `0x${hash.substring(0, 8)}`;
			return funcSelector === selector;
		});
		return func;
	}

	private getEventByName(name: string): JsonFragment | undefined {
		return this.abi.find((item) => item.type === 'event' && item.name === name);
	}

	private getEventByTopic(topic: string): JsonFragment | undefined {
		const events = this.abi.filter((item) => item.type === 'event');
		const event = events.find((event) => {
			const name = event.name;
			const jsonInputs = event.inputs;
			if (!name || !jsonInputs) {
				return false;
			}
			const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
			const signature = Coder.getSignature(name, inputs);
			const eventTopic = `0x${sha3.keccak256(signature)}`;
			return eventTopic === topic;
		});
		return event;
	}

	private static getSignature(name: string, inputs: ParamType[]): string {
		const types: string[] = [];
		for (const input of inputs) {
			if (input.type === 'tuple') {
				const tupleString = Coder.getSignature('', input.components);
				types.push(tupleString);
				continue;
			}
			if (input.type === 'tuple[]') {
				const tupleString = Coder.getSignature('', input.components);
				const arrayString = `${tupleString}[]`;
				types.push(arrayString);
				continue;
			}
			types.push(input.type);
		}
		const typeString = types.join(',');
		const functionSignature = `${name}(${typeString})`;
		return functionSignature;
	}
}

export default Coder;
